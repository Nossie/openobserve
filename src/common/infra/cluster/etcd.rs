// Copyright 2025 OpenObserve Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

use std::sync::atomic::Ordering;

use config::{
    cluster::*,
    get_config,
    meta::cluster::{Node, NodeStatus, Role, RoleGroup},
    utils::json,
};
use etcd_client::PutOptions;
use infra::{
    db::etcd,
    dist_lock,
    errors::{Error, Result},
};

/// Register and keep alive the node to cluster
pub(crate) async fn register_and_keep_alive() -> Result<()> {
    if let Err(e) = register().await {
        log::error!("[CLUSTER] register failed: {}", e);
        return Err(e);
    }

    // keep alive
    tokio::task::spawn(async move {
        // check if the node is already online
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            if is_online() {
                break;
            }
        }
        // after the node is online, keep alive
        let ttl_keep_alive = std::cmp::max(1, (get_config().limit.node_heartbeat_ttl / 4) as u64);
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(ttl_keep_alive)).await;
            loop {
                if is_offline() {
                    break;
                }
                match set_online(true).await {
                    Ok(_) => {
                        break;
                    }
                    Err(e) => {
                        log::error!("[CLUSTER] keep alive failed: {}", e);
                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                        continue;
                    }
                }
            }
        }
    });

    Ok(())
}

/// Register to cluster
async fn register() -> Result<()> {
    let cfg = get_config();
    // 1. create a cluster lock for node register
    let locker = dist_lock::lock("/nodes/register", cfg.limit.node_heartbeat_ttl as u64).await?;

    // 2. watch node list
    tokio::task::spawn(async move { super::watch_node_list().await });

    // 3. get node list
    let node_list = match super::list_nodes().await {
        Ok(v) => v,
        Err(e) => {
            dist_lock::unlock(&locker).await?;
            return Err(e);
        }
    };

    // 4. calculate node_id
    let mut node_ids = Vec::new();
    let mut w = super::NODES.write().await;
    for node in node_list {
        if node.is_interactive_querier() {
            super::add_node_to_consistent_hash(&node, &Role::Querier, Some(RoleGroup::Interactive))
                .await;
        }
        if node.is_background_querier() {
            super::add_node_to_consistent_hash(&node, &Role::Querier, Some(RoleGroup::Background))
                .await;
        }
        if node.is_compactor() {
            super::add_node_to_consistent_hash(&node, &Role::Compactor, None).await;
        }
        if node.is_flatten_compactor() {
            super::add_node_to_consistent_hash(&node, &Role::FlattenCompactor, None).await;
        }
        node_ids.push(node.id);
        w.insert(node.uuid.clone(), node);
    }
    drop(w);

    node_ids.sort();
    node_ids.dedup();
    log::debug!("node_ids: {:?}", node_ids);

    let mut new_node_id = 1;
    for id in node_ids {
        if id == new_node_id {
            new_node_id += 1;
        } else {
            break;
        }
    }
    log::debug!("new_node_id: {:?}", new_node_id);
    // update local id
    unsafe {
        LOCAL_NODE_ID = new_node_id;
    }

    // 4. join the cluster
    let key = format!("{}nodes/{}", &cfg.etcd.prefix, LOCAL_NODE.uuid);
    let node = Node {
        id: new_node_id,
        uuid: LOCAL_NODE.uuid.clone(),
        name: cfg.common.instance_name.clone(),
        http_addr: format!(
            "{}://{}:{}",
            get_http_schema(),
            get_local_http_ip(),
            cfg.http.port
        ),
        grpc_addr: format!(
            "{}://{}:{}",
            get_grpc_schema(),
            get_local_grpc_ip(),
            cfg.grpc.port
        ),
        role: LOCAL_NODE.role.clone(),
        role_group: LOCAL_NODE.role_group,
        cpu_num: cfg.limit.cpu_num as u64,
        status: NodeStatus::Prepare,
        scheduled: false,
        broadcasted: false,
        metrics: Default::default(),
        version: config::VERSION.to_string(),
    };
    let val = json::to_string(&node).unwrap();

    // cache local node
    if node.is_interactive_querier() {
        super::add_node_to_consistent_hash(&node, &Role::Querier, Some(RoleGroup::Interactive))
            .await;
    }
    if node.is_background_querier() {
        super::add_node_to_consistent_hash(&node, &Role::Querier, Some(RoleGroup::Background))
            .await;
    }
    if node.is_compactor() {
        super::add_node_to_consistent_hash(&node, &Role::Compactor, None).await;
    }
    if node.is_flatten_compactor() {
        super::add_node_to_consistent_hash(&node, &Role::FlattenCompactor, None).await;
    }

    let mut w = super::NODES.write().await;
    w.insert(LOCAL_NODE.uuid.clone(), node.clone());
    drop(w);

    // register node to cluster
    let mut client = etcd::get_etcd_client().await.clone();
    let resp = match client.lease_grant(cfg.limit.node_heartbeat_ttl, None).await {
        Ok(v) => v,
        Err(e) => {
            dist_lock::unlock(&locker).await?;
            return Err(Error::Message(e.to_string()));
        }
    };
    let id = resp.id();
    // update local node key lease id
    unsafe {
        LOCAL_NODE_KEY_LEASE_ID = id;
    }
    let opt = PutOptions::new().with_lease(id);
    if let Err(e) = client.put(key, val, Some(opt)).await {
        dist_lock::unlock(&locker).await?;
        return Err(Error::Message(format!("register node error: {}", e)));
    }

    // 7. register ok, release lock
    dist_lock::unlock(&locker).await?;

    log::info!("[CLUSTER] Register to cluster ok");
    Ok(())
}

pub(crate) async fn set_online(new_lease_id: bool) -> Result<()> {
    set_status(NodeStatus::Online, new_lease_id).await
}

pub(crate) async fn set_offline(new_lease_id: bool) -> Result<()> {
    set_status(NodeStatus::Offline, new_lease_id).await
}

/// set online to cluster
pub(crate) async fn set_status(status: NodeStatus, new_lease_id: bool) -> Result<()> {
    let cfg = get_config();
    // set node status to online
    let mut node = match super::NODES.read().await.get(LOCAL_NODE.uuid.as_str()) {
        Some(node) => {
            let mut val = node.clone();
            val.status = status.clone();
            val
        }
        None => Node {
            id: unsafe { LOCAL_NODE_ID },
            uuid: LOCAL_NODE.uuid.clone(),
            name: cfg.common.instance_name.clone(),
            http_addr: format!(
                "{}://{}:{}",
                get_http_schema(),
                get_local_http_ip(),
                cfg.http.port
            ),
            grpc_addr: format!(
                "{}://{}:{}",
                get_grpc_schema(),
                get_local_grpc_ip(),
                cfg.grpc.port
            ),
            role: LOCAL_NODE.role.clone(),
            role_group: LOCAL_NODE.role_group,
            cpu_num: cfg.limit.cpu_num as u64,
            status: status.clone(),
            scheduled: false,
            broadcasted: false,
            metrics: Default::default(),
            version: config::VERSION.to_string(),
        },
    };

    // update node status metrics
    node.metrics = super::update_node_status_metrics().await;

    let val = json::to_string(&node).unwrap();

    LOCAL_NODE_STATUS.store(status as _, Ordering::Release);

    if new_lease_id {
        // get new lease id
        let mut client = etcd::get_etcd_client().await.clone();
        let resp = client
            .lease_grant(cfg.limit.node_heartbeat_ttl, None)
            .await?;
        let lease_id = resp.id();
        // update local node key lease id
        unsafe {
            LOCAL_NODE_KEY_LEASE_ID = lease_id;
        }
    }

    let key = format!("{}nodes/{}", &cfg.etcd.prefix, LOCAL_NODE.uuid);
    let opt = PutOptions::new().with_lease(unsafe { LOCAL_NODE_KEY_LEASE_ID });
    let mut client = etcd::get_etcd_client().await.clone();
    if let Err(e) = client.put(key, val, Some(opt)).await {
        return Err(Error::Message(format!("online node error: {}", e)));
    }

    Ok(())
}

/// Leave cluster
pub(crate) async fn leave() -> Result<()> {
    let key = format!("{}nodes/{}", get_config().etcd.prefix, LOCAL_NODE.uuid);
    let mut client = etcd::get_etcd_client().await.clone();
    if let Err(e) = client.delete(key, None).await {
        return Err(Error::Message(format!("leave node error: {}", e)));
    }

    Ok(())
}

pub(crate) async fn update_local_node(node: &Node) -> Result<()> {
    let key = format!("{}nodes/{}", get_config().etcd.prefix, LOCAL_NODE.uuid);
    let opt = PutOptions::new().with_lease(unsafe { LOCAL_NODE_KEY_LEASE_ID });
    let val = json::to_string(&node).unwrap();
    let mut client = etcd::get_etcd_client().await.clone();
    if let Err(e) = client.put(key, val, Some(opt)).await {
        return Err(Error::Message(format!("update node error: {}", e)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_etcd_update_local_node() {
        let node = Node::default();
        let _ = update_local_node(&node).await.is_err();
    }

    #[tokio::test]
    async fn test_etcd_set_status() {
        let _ = set_status(NodeStatus::Online, true).await.is_err();
    }

    #[tokio::test]
    async fn test_etcd_set_offline() {
        let _ = set_offline(true).await.is_err();
    }

    #[tokio::test]
    async fn test_etcd_leave() {
        let _ = leave().await.is_err();
    }

    #[tokio::test]
    async fn test_etcd_register_and_keep_alive() {
        config::cache_instance_id("instance");
        let _ = register_and_keep_alive().await.is_err();
    }

    #[tokio::test]
    async fn test_etcd_register() {
        config::cache_instance_id("instance");
        let _ = register().await.is_err();
    }
}
