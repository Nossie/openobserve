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

use std::collections::VecDeque;

use bytes::Bytes as BytesImpl;
use hashbrown::HashMap;
use proto::cluster_rpc;
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;

use crate::{
    config::get_config,
    meta::{sql::OrderBy, stream::StreamType},
    utils::{base64, json},
};

pub const PARTIAL_ERROR_RESPONSE_MESSAGE: &str =
    "Please be aware that the response is based on partial data";

/// To represent the query start and end time based of partition or cache
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimeOffset {
    pub start_time: i64,
    pub end_time: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageType {
    Memory,
    Wal,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub storage_type: StorageType,
    pub work_group: Option<String>,
    pub target_partitions: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
#[schema(as = SearchRequest)]
pub struct Request {
    #[schema(value_type = SearchQuery)]
    pub query: Query,
    #[serde(default)]
    pub encoding: RequestEncoding,
    #[serde(default)]
    pub regions: Vec<String>, // default query all regions, local: only query local region clusters
    #[serde(default)]
    pub clusters: Vec<String>, // default query all clusters, local: only query local cluster
    #[serde(default)]
    pub timeout: i64,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_type: Option<SearchEventType>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_event_context: Option<SearchEventContext>,
    #[serde(default = "default_use_cache")]
    pub use_cache: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_mode: Option<bool>,
}

pub fn default_use_cache() -> bool {
    get_config().common.result_cache_enabled
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum RequestEncoding {
    #[serde(rename = "base64")]
    Base64,
    #[default]
    #[serde(rename = "")]
    Empty,
}

impl From<&str> for RequestEncoding {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "base64" => RequestEncoding::Base64,
            _ => RequestEncoding::Empty,
        }
    }
}

impl std::fmt::Display for RequestEncoding {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            RequestEncoding::Base64 => write!(f, "base64"),
            RequestEncoding::Empty => write!(f, ""),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[schema(as = SearchQuery)]
pub struct Query {
    pub sql: String,
    #[serde(default)]
    pub from: i64,
    #[serde(default = "default_size")]
    pub size: i64,
    #[serde(default)]
    pub start_time: i64,
    #[serde(default)]
    pub end_time: i64,
    #[serde(default)]
    pub quick_mode: bool,
    #[serde(default)]
    pub query_type: String,
    #[serde(default)]
    pub track_total_hits: bool,
    #[serde(default)]
    pub uses_zo_fn: bool,
    #[serde(default)]
    pub query_fn: Option<String>,
    #[serde(default)]
    pub action_id: Option<String>,
    #[serde(default)]
    pub skip_wal: bool,
    // streaming output
    #[serde(default)]
    pub streaming_output: bool,
    #[serde(default)]
    pub streaming_id: Option<String>,
    #[serde(default)]
    pub histogram_interval: i64,
}

fn default_size() -> i64 {
    crate::get_config().limit.query_default_limit
}

impl Default for Query {
    fn default() -> Self {
        Query {
            sql: "".to_string(),
            from: 0,
            size: 10,
            start_time: 0,
            end_time: 0,
            quick_mode: false,
            query_type: "".to_string(),
            track_total_hits: false,
            uses_zo_fn: false,
            query_fn: None,
            action_id: None,
            skip_wal: false,
            streaming_output: false,
            streaming_id: None,
            histogram_interval: 0,
        }
    }
}

impl Request {
    #[inline]
    pub fn decode(&mut self) -> Result<(), std::io::Error> {
        match self.encoding {
            RequestEncoding::Base64 => {
                self.query.sql = match base64::decode_url(&self.query.sql) {
                    Ok(v) => {
                        match crate::utils::query_select_utils::replace_o2_custom_patterns(&v) {
                            Ok(sql) => sql,
                            Err(e) => {
                                log::error!(
                                    "Error replacing o2 custom patterns , returning original sql: {}",
                                    e
                                );
                                v
                            }
                        }
                    }
                    Err(e) => {
                        return Err(e);
                    }
                };
            }
            RequestEncoding::Empty => {}
        }
        self.encoding = RequestEncoding::Empty;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, ToSchema)]
#[schema(as = SearchResponse)]
pub struct Response {
    pub took: usize,
    #[serde(default)]
    pub took_detail: ResponseTook,
    #[serde(default)]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
    #[schema(value_type = Vec<Object>)]
    pub hits: Vec<json::Value>,
    pub total: usize,
    pub from: i64,
    pub size: i64,
    #[serde(default)]
    #[serde(skip_serializing)]
    pub file_count: usize,
    pub cached_ratio: usize,
    pub scan_size: usize,
    pub idx_scan_size: usize,
    pub scan_records: usize,
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub response_type: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub trace_id: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub function_error: Vec<String>,
    #[serde(default)]
    pub is_partial: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub histogram_interval: Option<i64>, // seconds, for histogram
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_start_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_end_time: Option<i64>,
    #[serde(default)]
    pub result_cache_ratio: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_by: Option<OrderBy>,
}

/// Iterator for Streaming response of search `Response`
///
/// This is used to split the search response to smaller chunks based on
/// env variable
/// The format of the iterator is as follows:
/// - Chunk 1: Response Metadata
/// - Chunk 2: Hits (1MB)
/// - Chunk 3: Hits (1MB)
pub struct ResponseChunkIterator {
    // Original response (will be split into chunks)
    response: Response,
    // Target size for each chunk in bytes
    chunk_size: usize,
    // Hits waiting to be processed
    remaining_hits: VecDeque<crate::utils::json::Value>,
    // Whether metadata has been sent
    metadata_sent: bool,
    // Current position in the iteration
    position: usize,
}

impl ResponseChunkIterator {
    /// Create a new response chunk iterator
    pub fn new(mut response: Response, chunk_size: Option<usize>) -> Self {
        // Get the configured chunk size or use the provided one or default
        let chunk_size = chunk_size.unwrap_or_else(|| {
            // Get from config, convert from MB to bytes
            let mb = 1024 * 1024;
            crate::get_config().websocket.streaming_response_chunk_size * mb
        });

        let hits = response.hits.drain(..).collect::<Vec<_>>();

        Self {
            response,
            chunk_size,
            remaining_hits: VecDeque::from(hits),
            metadata_sent: false,
            position: 0,
        }
    }
}

// Define the possible chunk types
#[derive(Debug, Clone)]
pub enum ResponseChunk {
    Metadata {
        response: Box<Response>,
    },
    Hits {
        hits: Vec<crate::utils::json::Value>,
    },
}

impl Iterator for ResponseChunkIterator {
    type Item = ResponseChunk;

    fn next(&mut self) -> Option<Self::Item> {
        // First send metadata
        if !self.metadata_sent {
            self.metadata_sent = true;
            self.position += 1;

            // Clone response but remove hits
            let mut metadata_response = self.response.clone();
            metadata_response.hits = vec![];

            return Some(ResponseChunk::Metadata {
                response: Box::new(metadata_response),
            });
        }

        // If we have no hits left, we're done
        if self.remaining_hits.is_empty() {
            return None;
        }

        // Create the next chunk of hits
        let mut current_chunk: Vec<crate::utils::json::Value> = Vec::new();
        let mut current_chunk_size: usize = 0;

        // Keep adding hits until we reach the target chunk size
        while !self.remaining_hits.is_empty() {
            // Peek at the front hit
            let hit = &self.remaining_hits[0];
            let hit_size = crate::utils::json::estimate_json_bytes(hit);

            if hit_size > self.chunk_size {
                return Some(ResponseChunk::Hits {
                    hits: vec![hit.to_owned()],
                });
            }

            // If adding this hit would exceed target size, break
            if !current_chunk.is_empty() && current_chunk_size + hit_size > self.chunk_size {
                break;
            }

            // Add hit to current chunk - using pop_front() for O(1) complexity
            if let Some(hit) = self.remaining_hits.pop_front() {
                current_chunk.push(hit);
                current_chunk_size += hit_size;
            }
        }

        self.position += 1;

        // Return the hits chunk
        Some(ResponseChunk::Hits {
            hits: current_chunk,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, ToSchema)]
pub struct ResponseTook {
    pub total: usize,
    pub cache_took: usize,
    pub file_list_took: usize,
    pub wait_in_queue: usize,
    pub idx_took: usize,
    pub search_took: usize,
}

impl ResponseTook {
    pub fn add(&mut self, other: &ResponseTook) {
        self.cache_took += other.cache_took;
        self.file_list_took += other.file_list_took;
        self.wait_in_queue += other.wait_in_queue;
        self.idx_took += other.idx_took;
        self.search_took += other.search_took;
    }
}

impl Response {
    pub fn new(from: i64, size: i64) -> Self {
        Response {
            took: 0,
            took_detail: ResponseTook::default(),
            total: 0,
            from,
            size,
            file_count: 0,
            cached_ratio: 0,
            scan_size: 0,
            idx_scan_size: 0,
            scan_records: 0,
            columns: Vec::new(),
            hits: Vec::new(),
            response_type: "".to_string(),
            trace_id: "".to_string(),
            function_error: Vec::new(),
            is_partial: false,
            histogram_interval: None,
            new_start_time: None,
            new_end_time: None,
            result_cache_ratio: 0,
            work_group: None,
            order_by: None,
        }
    }

    pub fn pagination(&mut self, from: i64, size: i64) {
        self.from = from;
        self.size = size;
        if from >= self.total as i64 {
            self.hits = Vec::new();
            self.total = 0;
            return;
        }

        self.hits = self
            .hits
            .iter()
            .skip(from as usize)
            .take(size as usize)
            .cloned()
            .collect();
    }

    pub fn add_hit(&mut self, hit: &json::Value) {
        self.hits.push(hit.to_owned());
        self.total += 1;
    }

    // set the total took time of the search request, it includes everything.
    pub fn set_took(&mut self, val: usize) {
        self.took = val;
        self.took_detail.total = val;
    }

    pub fn set_cache_took(&mut self, val: usize) {
        self.took_detail.cache_took = val;
    }

    pub fn set_wait_in_queue(&mut self, val: usize) {
        self.took_detail.wait_in_queue = val;
    }

    pub fn set_search_took(&mut self, total: usize, file_list: usize, idx: usize) {
        self.took_detail.search_took = total - file_list - idx;
        self.took_detail.file_list_took = file_list;
        self.took_detail.idx_took = idx;
    }

    pub fn set_total(&mut self, val: usize) {
        self.total = val;
    }

    pub fn set_file_count(&mut self, val: usize) {
        self.file_count = val;
    }

    pub fn set_cached_ratio(&mut self, val: usize) {
        self.cached_ratio = val;
    }

    pub fn set_scan_size(&mut self, val: usize) {
        self.scan_size = val;
    }

    pub fn set_idx_scan_size(&mut self, val: usize) {
        self.idx_scan_size = val;
    }

    pub fn set_scan_records(&mut self, val: usize) {
        self.scan_records = val;
    }

    pub fn set_trace_id(&mut self, trace_id: String) {
        self.trace_id = trace_id;
    }

    pub fn set_partial(&mut self, is_partial: bool, msg: String) {
        self.is_partial = is_partial;
        if !msg.is_empty() {
            if self.function_error.is_empty() {
                self.function_error = vec![msg];
            } else {
                self.function_error.push(msg);
            }
        }
    }

    pub fn set_histogram_interval(&mut self, val: Option<i64>) {
        self.histogram_interval = val;
    }

    pub fn set_work_group(&mut self, val: Option<String>) {
        self.work_group = val;
    }

    pub fn set_order_by(&mut self, val: Option<OrderBy>) {
        self.order_by = val;
    }

    pub fn set_result_cache_ratio(&mut self, val: usize) {
        self.result_cache_ratio = val;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct SearchPartitionRequest {
    pub sql: String,
    pub start_time: i64,
    pub end_time: i64,
    #[serde(default)]
    pub encoding: RequestEncoding,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub clusters: Vec<String>,
    #[serde(default)]
    pub query_fn: Option<String>,
    #[serde(default)]
    pub streaming_output: bool,
}

impl SearchPartitionRequest {
    #[inline]
    pub fn decode(&mut self) -> Result<(), std::io::Error> {
        match self.encoding {
            RequestEncoding::Base64 => {
                self.sql = match base64::decode_url(&self.sql) {
                    Ok(v) => v,
                    Err(e) => {
                        return Err(e);
                    }
                };
            }
            RequestEncoding::Empty => {}
        }
        self.encoding = RequestEncoding::Empty;
        Ok(())
    }
}

impl From<&Request> for SearchPartitionRequest {
    fn from(req: &Request) -> Self {
        SearchPartitionRequest {
            sql: req.query.sql.clone(),
            start_time: req.query.start_time,
            end_time: req.query.end_time,
            encoding: req.encoding,
            regions: req.regions.clone(),
            clusters: req.clusters.clone(),
            query_fn: req.query.query_fn.clone(),
            streaming_output: req.query.streaming_output,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct SearchPartitionResponse {
    pub trace_id: String,
    pub file_num: usize,
    pub records: usize,
    pub original_size: usize,
    pub compressed_size: usize,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub histogram_interval: Option<i64>, // seconds, for histogram
    pub max_query_range: i64, // hours, for histogram
    pub partitions: Vec<[i64; 2]>,
    pub order_by: OrderBy,
    pub limit: i64,
    pub streaming_output: bool,
    pub streaming_aggs: bool,
    pub streaming_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct SearchHistoryRequest {
    pub org_id: Option<String>,
    pub stream_type: Option<String>,
    pub stream_name: Option<String>,
    pub start_time: i64,
    pub end_time: i64,
    pub trace_id: Option<String>,
    pub user_email: Option<String>,
    #[serde(default = "default_size")]
    pub size: i64,
}

impl SearchHistoryRequest {
    pub fn validate(&self) -> Result<bool, String> {
        if self.start_time >= self.end_time {
            return Err("start_time must be less than end_time".to_string());
        }
        Ok(true)
    }

    fn build_query(&self, search_stream_name: &str) -> Result<String, String> {
        self.validate()?;

        // Create the query
        let query = search_history_utils::SearchHistoryQueryBuilder::new()
            .with_org_id(&self.org_id)
            .with_stream_type(&self.stream_type)
            .with_stream_name(&self.stream_name)
            .with_trace_id(&self.trace_id)
            .with_user_email(&self.user_email)
            .build(search_stream_name);

        Ok(query)
    }

    pub fn to_query_req(&self, search_stream_name: &str) -> Result<Request, String> {
        let sql = self.build_query(search_stream_name)?;

        let search_req = Request {
            query: Query {
                sql,
                from: 0,
                size: self.size,
                start_time: self.start_time,
                end_time: self.end_time,
                quick_mode: false,
                query_type: "".to_string(),
                track_total_hits: false,
                uses_zo_fn: false,
                query_fn: None,
                action_id: None,
                skip_wal: false,
                streaming_output: false,
                streaming_id: None,
                histogram_interval: 0,
            },
            encoding: RequestEncoding::Empty,
            regions: Vec::new(),
            clusters: Vec::new(),
            timeout: 0,
            search_type: Some(SearchEventType::Other),
            search_event_context: None,
            use_cache: default_use_cache(),
            local_mode: None,
        };
        Ok(search_req)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct SearchHistoryHitResponse {
    pub org_id: String,
    pub stream_type: String,
    pub stream_name: String,
    #[serde(rename = "start_time")]
    pub min_ts: i64,
    #[serde(rename = "end_time")]
    pub max_ts: i64,
    #[serde(rename = "sql")]
    pub request_body: String,
    #[serde(rename = "scan_size")]
    pub size: f64,
    #[serde(rename = "scan_records")]
    pub num_records: i64,
    #[serde(rename = "took")]
    pub response_time: f64,
    pub cached_ratio: i64,
    pub trace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
}

impl TryFrom<json::Value> for SearchHistoryHitResponse {
    type Error = String;

    fn try_from(value: json::Value) -> Result<Self, Self::Error> {
        Ok(SearchHistoryHitResponse {
            org_id: value
                .get("org_id")
                .and_then(|v| v.as_str())
                .ok_or("org_id missing".to_string())?
                .to_string(),
            stream_type: value
                .get("stream_type")
                .and_then(|v| v.as_str())
                .ok_or("stream_type missing".to_string())?
                .to_string(),
            stream_name: value
                .get("stream_name")
                .and_then(|v| v.as_str())
                .ok_or("stream_name missing".to_string())?
                .to_string(),
            min_ts: value
                .get("min_ts")
                .and_then(|v| v.as_i64())
                .ok_or("min_ts missing".to_string())?,
            max_ts: value
                .get("max_ts")
                .and_then(|v| v.as_i64())
                .ok_or("max_ts missing".to_string())?,
            request_body: value
                .get("request_body")
                .and_then(|v| v.as_str())
                .ok_or("request_body".to_string())?
                .to_string(),
            size: value
                .get("size")
                .and_then(|v| v.as_f64())
                .ok_or("size missing".to_string())?,
            num_records: value
                .get("num_records")
                .and_then(|v| v.as_i64())
                .ok_or("num_records missing".to_string())?,
            response_time: value
                .get("response_time")
                .and_then(|v| v.as_f64())
                .ok_or("response_time missing".to_string())?,
            cached_ratio: value
                .get("cached_ratio")
                .and_then(|v| v.as_i64())
                .ok_or("cached_ratio missing".to_string())?,
            trace_id: value
                .get("trace_id")
                .and_then(|v| v.as_str())
                .ok_or("trace_id missing".to_string())?
                .to_string(),
            function: value
                .get("function")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            _timestamp: value.get("_timestamp").and_then(|v| v.as_i64()),
            unit: value
                .get("unit")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            event: value
                .get("event")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
        })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct QueryStatusResponse {
    pub status: Vec<QueryStatus>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct QueryStatus {
    pub trace_id: String,
    pub status: String,
    pub created_at: i64,
    pub started_at: i64,
    pub work_group: String,
    pub user_id: Option<String>,
    pub org_id: Option<String>,
    pub stream_type: Option<String>,
    pub query: Option<QueryInfo>,
    pub scan_stats: Option<ScanStats>,
    pub search_type: Option<SearchEventType>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct QueryInfo {
    pub sql: String,
    pub start_time: i64,
    pub end_time: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct CancelQueryResponse {
    pub trace_id: String,
    pub is_success: bool,
}

#[derive(Clone, Debug, Copy, Default, Serialize, Deserialize, ToSchema)]
pub struct ScanStats {
    pub files: i64,
    pub records: i64,
    pub original_size: i64,
    pub compressed_size: i64,
    pub querier_files: i64,
    pub querier_memory_cached_files: i64,
    pub querier_disk_cached_files: i64,
    pub idx_scan_size: i64,
    pub idx_took: i64,
    pub file_list_took: i64,
    pub aggs_cache_ratio: i64,
}

impl ScanStats {
    pub fn new() -> Self {
        ScanStats::default()
    }

    pub fn add(&mut self, other: &ScanStats) {
        self.files += other.files;
        self.records += other.records;
        self.original_size += other.original_size;
        self.compressed_size += other.compressed_size;
        self.querier_files += other.querier_files;
        self.querier_memory_cached_files += other.querier_memory_cached_files;
        self.querier_disk_cached_files += other.querier_disk_cached_files;
        self.idx_scan_size += other.idx_scan_size;
        self.idx_took = std::cmp::max(self.idx_took, other.idx_took);
        self.file_list_took = std::cmp::max(self.file_list_took, other.file_list_took);
        self.aggs_cache_ratio = std::cmp::min(self.aggs_cache_ratio, other.aggs_cache_ratio);
    }

    pub fn format_to_mb(&mut self) {
        self.original_size = self.original_size / 1024 / 1024;
        self.compressed_size = self.compressed_size / 1024 / 1024;
        self.idx_scan_size = self.idx_scan_size / 1024 / 1024;
    }
}

impl From<Query> for cluster_rpc::SearchQuery {
    fn from(query: Query) -> Self {
        cluster_rpc::SearchQuery {
            sql: query.sql.clone(),
            quick_mode: query.quick_mode,
            query_type: query.query_type.clone(),
            from: query.from as i32,
            size: query.size as i32,
            start_time: query.start_time,
            end_time: query.end_time,
            track_total_hits: query.track_total_hits,
            uses_zo_fn: query.uses_zo_fn,
            query_fn: query.query_fn.unwrap_or_default(),
            action_id: query.action_id.unwrap_or_default(),
            skip_wal: query.skip_wal,
            histogram_interval: query.histogram_interval,
        }
    }
}

impl From<&ScanStats> for cluster_rpc::ScanStats {
    fn from(req: &ScanStats) -> Self {
        cluster_rpc::ScanStats {
            files: req.files,
            records: req.records,
            original_size: req.original_size,
            compressed_size: req.compressed_size,
            querier_files: req.querier_files,
            querier_memory_cached_files: req.querier_memory_cached_files,
            querier_disk_cached_files: req.querier_disk_cached_files,
            idx_scan_size: req.idx_scan_size,
            idx_took: req.idx_took,
            file_list_took: req.file_list_took,
            aggs_cache_ratio: req.aggs_cache_ratio,
        }
    }
}

impl From<&cluster_rpc::ScanStats> for ScanStats {
    fn from(req: &cluster_rpc::ScanStats) -> Self {
        ScanStats {
            files: req.files,
            records: req.records,
            original_size: req.original_size,
            compressed_size: req.compressed_size,
            querier_files: req.querier_files,
            querier_memory_cached_files: req.querier_memory_cached_files,
            querier_disk_cached_files: req.querier_disk_cached_files,
            idx_scan_size: req.idx_scan_size,
            idx_took: req.idx_took,
            file_list_took: req.file_list_took,
            aggs_cache_ratio: req.aggs_cache_ratio,
        }
    }
}

#[derive(Hash, Clone, Copy, Debug, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SearchEventType {
    UI,
    Dashboards,
    Reports,
    Alerts,
    Values,
    Other,
    RUM,
    DerivedStream,
    SearchJob,
}

impl<'de> Deserialize<'de> for SearchEventType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FieldVisitor;

        impl serde::de::Visitor<'_> for FieldVisitor {
            type Value = SearchEventType;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("Invalid SearchEventType")
            }

            fn visit_str<E>(self, value: &str) -> Result<SearchEventType, E>
            where
                E: serde::de::Error,
            {
                SearchEventType::try_from(value).map_err(serde::de::Error::custom)
            }
        }

        deserializer.deserialize_identifier(FieldVisitor)
    }
}

impl std::fmt::Display for SearchEventType {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            SearchEventType::UI => write!(f, "ui"),
            SearchEventType::Dashboards => write!(f, "dashboards"),
            SearchEventType::Reports => write!(f, "reports"),
            SearchEventType::Alerts => write!(f, "alerts"),
            SearchEventType::Values => write!(f, "_values"),
            SearchEventType::Other => write!(f, "other"),
            SearchEventType::RUM => write!(f, "rum"),
            SearchEventType::DerivedStream => write!(f, "derived_stream"),
            SearchEventType::SearchJob => write!(f, "search_job"),
        }
    }
}

impl TryFrom<&str> for SearchEventType {
    type Error = String;
    fn try_from(s: &str) -> std::result::Result<Self, Self::Error> {
        let s = s.to_lowercase();
        match s.as_str() {
            "ui" => Ok(SearchEventType::UI),
            "dashboards" => Ok(SearchEventType::Dashboards),
            "reports" => Ok(SearchEventType::Reports),
            "alerts" => Ok(SearchEventType::Alerts),
            "values" | "_values" => Ok(SearchEventType::Values),
            "other" => Ok(SearchEventType::Other),
            "rum" => Ok(SearchEventType::RUM),
            "derived_stream" | "derivedstream" => Ok(SearchEventType::DerivedStream),
            "search_job" | "searchjob" => Ok(SearchEventType::SearchJob),
            _ => Err(format!(
                "invalid SearchEventType `{s}`, expected one of `ui`, `dashboards`, `reports`, `alerts`, `values`, `other`, `rum`, `derived_stream`, `search_job`"
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct ValuesEventContext {
    pub top_k: Option<i64>,
    pub no_count: bool,
    pub field: String,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct SearchEventContext {
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert_key: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_stream_key: Option<String>,
    #[serde(default)]
    #[serde(rename = "report_id")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_key: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_id: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_name: Option<String>,
    #[serde(default)]
    #[serde(rename = "folder_id")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_folder_id: Option<String>,
    #[serde(default)]
    #[serde(rename = "folder_name")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dashboard_folder_name: Option<String>,
}

impl SearchEventContext {
    pub fn with_alert(alert_key: Option<String>) -> Self {
        Self {
            alert_key,
            ..Default::default()
        }
    }

    pub fn with_derived_stream(derived_stream_key: Option<String>) -> Self {
        Self {
            derived_stream_key,
            ..Default::default()
        }
    }

    pub fn with_report(report_key: Option<String>) -> Self {
        Self {
            report_key,
            ..Default::default()
        }
    }

    pub fn with_dashboard(
        dashboard_id: Option<String>,
        dashboard_name: Option<String>,
        dashboard_folder_id: Option<String>,
        dashboard_folder_name: Option<String>,
    ) -> Self {
        Self {
            dashboard_id,
            dashboard_name,
            dashboard_folder_id,
            dashboard_folder_name,
            ..Default::default()
        }
    }

    pub fn enrich_for_dashboard(
        &mut self,
        dashboard_title: String,
        folder_name: String,
        folder_id: String,
    ) {
        self.dashboard_name = Some(dashboard_title);
        self.dashboard_folder_name = Some(folder_name);
        self.dashboard_folder_id = Some(folder_id);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct MultiSearchPartitionRequest {
    pub sql: Vec<String>,
    pub start_time: i64,
    pub end_time: i64,
    #[serde(default)]
    pub encoding: RequestEncoding,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub clusters: Vec<String>,
    #[serde(default)]
    pub query_fn: Option<String>,
    #[serde(default)]
    pub streaming_output: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct MultiSearchPartitionResponse {
    pub success: hashbrown::HashMap<String, SearchPartitionResponse>,
    pub error: hashbrown::HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct SqlQuery {
    pub sql: String,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub query_fn: Option<String>,
    #[serde(default)]
    pub is_old_format: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[schema(as = SearchRequest)]
pub struct MultiStreamRequest {
    #[serde(default, deserialize_with = "deserialize_sql")]
    pub sql: Vec<SqlQuery>, // Use the new struct for SQL queries
    #[serde(default)]
    pub encoding: RequestEncoding,
    #[serde(default)]
    pub timeout: i64,
    #[serde(default)]
    pub from: i64,
    #[serde(default = "default_size")]
    pub size: i64,
    pub start_time: i64,
    pub end_time: i64,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub quick_mode: bool,
    #[serde(default)]
    pub query_type: String,
    #[serde(default)]
    pub track_total_hits: bool,
    #[serde(default)]
    pub uses_zo_fn: bool,
    #[serde(default)]
    pub query_fn: Option<String>,
    #[serde(default)]
    pub skip_wal: bool,
    #[serde(default)]
    pub regions: Vec<String>, // default query all regions, local: only query local region clusters
    #[serde(default)]
    pub clusters: Vec<String>, // default query all clusters, local: only query local cluster
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_type: Option<SearchEventType>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_event_context: Option<SearchEventContext>,
    #[serde(default)]
    pub index_type: String, // parquet(default) or fst
    #[serde(default)]
    pub per_query_response: bool,
}

fn deserialize_sql<'de, D>(deserializer: D) -> Result<Vec<SqlQuery>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SqlOrSqlQuery {
        OldFormat(String),
        NewFormat(SqlQuery),
    }

    let v: Vec<SqlOrSqlQuery> = Vec::deserialize(deserializer)?;

    // Convert old format into the new format
    let result: Vec<SqlQuery> = v
        .into_iter()
        .map(|item| match item {
            SqlOrSqlQuery::OldFormat(sql) => SqlQuery {
                sql,
                start_time: None,
                end_time: None,
                query_fn: None,
                is_old_format: true,
            },
            SqlOrSqlQuery::NewFormat(query) => query,
        })
        .collect();

    Ok(result)
}

impl MultiStreamRequest {
    pub fn to_query_req(&self) -> Vec<Request> {
        let mut res = vec![];
        for query in &self.sql {
            let query_fn = if query.is_old_format {
                self.query_fn
                    .as_ref()
                    .and_then(|v| base64::decode_url(v).ok())
            } else {
                query
                    .query_fn
                    .as_ref()
                    .and_then(|v| base64::decode_url(v).ok())
            };
            let sql = if let Ok(sql) =
                crate::utils::query_select_utils::replace_o2_custom_patterns(&query.sql)
            {
                sql
            } else {
                query.sql.clone()
            };
            res.push(Request {
                query: Query {
                    sql,
                    from: self.from,
                    size: self.size,
                    start_time: query.start_time.unwrap_or(self.start_time),
                    end_time: query.end_time.unwrap_or(self.end_time),
                    quick_mode: self.quick_mode,
                    query_type: self.query_type.clone(),
                    track_total_hits: self.track_total_hits,
                    uses_zo_fn: self.uses_zo_fn,
                    query_fn,
                    action_id: None,
                    skip_wal: self.skip_wal,
                    streaming_output: false,
                    streaming_id: None,
                    histogram_interval: 0,
                },
                regions: self.regions.clone(),
                clusters: self.clusters.clone(),
                encoding: self.encoding,
                timeout: self.timeout,
                search_type: self.search_type,
                search_event_context: self.search_event_context.clone(),
                use_cache: default_use_cache(),
                local_mode: None,
            });
        }
        res
    }
}

// for search job pagination
#[derive(Debug, Deserialize)]
pub struct PaginationQuery {
    pub from: Option<i64>,
    pub size: Option<i64>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct ValuesRequest {
    pub fields: Vec<String>,
    #[serde(default)]
    pub size: Option<i64>,
    pub no_count: bool,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub clusters: Vec<String>,
    #[serde(default)]
    pub vrl_fn: Option<String>,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub timeout: Option<i64>,
    #[serde(default)]
    pub use_cache: bool,
    pub stream_name: String,
    pub stream_type: StreamType,
    pub sql: String,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct HashFileRequest {
    pub files: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Clone, Serialize)]
pub struct HashFileResponse {
    pub files: HashMap<String, HashMap<String, String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_response() {
        let mut res = Response::default();
        res.set_total(10);
        res.set_file_count(5);
        let hit = json::json!({"num":12});
        let mut val_map = json::Map::new();
        val_map.insert("id".to_string(), json::json!({"id":1}));
        res.add_hit(&hit); // total+1
        assert_eq!(res.total, 11);
    }

    #[test]
    fn test_request_encoding() {
        let req = json::json!(
            {
                "query": {
                    "sql": "c2VsZWN0ICogZnJvbSB0ZXN0",
                    "from": 0,
                    "size": 10,
                    "start_time": 0,
                    "end_time": 0,
                    "track_total_hits": false
                },
                "encoding": "base64"
            }
        );
        let mut req: Request = json::from_value(req).unwrap();
        req.decode().unwrap();
        assert_eq!(req.query.sql, "select * from test");
    }

    #[test]
    fn test_request_no_encoding() {
        let req = json::json!(
            {
                "query": {
                    "sql": "select * from test",
                    "from": 0,
                    "size": 10,
                    "start_time": 0,
                    "end_time": 0,
                    "track_total_hits": false
                },
                "encoding": ""
            }
        );
        let mut req: Request = json::from_value(req).unwrap();
        req.decode().unwrap();
        assert_eq!(req.query.sql, "select * from test");
    }
}

mod search_history_utils {
    pub struct SearchHistoryQueryBuilder {
        pub org_id: Option<String>,
        pub stream_type: Option<String>,
        pub stream_name: Option<String>,
        pub user_email: Option<String>,
        pub trace_id: Option<String>,
    }

    impl SearchHistoryQueryBuilder {
        pub fn new() -> Self {
            Self {
                org_id: None,
                stream_type: None,
                stream_name: None,
                user_email: None,
                trace_id: None,
            }
        }

        pub fn with_org_id(mut self, org_id: &Option<String>) -> Self {
            self.org_id = org_id.to_owned();
            self
        }

        pub fn with_stream_type(mut self, stream_type: &Option<String>) -> Self {
            self.stream_type = stream_type.to_owned();
            self
        }

        pub fn with_stream_name(mut self, stream_name: &Option<String>) -> Self {
            self.stream_name = stream_name.to_owned();
            self
        }

        pub fn with_trace_id(mut self, trace_id: &Option<String>) -> Self {
            self.trace_id = trace_id.to_owned();
            self
        }

        pub fn with_user_email(mut self, email: &Option<String>) -> Self {
            self.user_email = email.to_owned();
            self
        }

        // Method to build the SQL query
        pub fn build(self, search_stream_name: &str) -> String {
            let mut query = format!("SELECT * FROM {} WHERE event='Search'", search_stream_name);

            if let Some(org_id) = self.org_id {
                if !org_id.is_empty() {
                    query.push_str(&format!(" AND org_id = '{}'", org_id));
                }
            }
            if let Some(stream_type) = self.stream_type {
                if !stream_type.is_empty() {
                    query.push_str(&format!(" AND stream_type = '{}'", stream_type));
                }
            }
            if let Some(stream_name) = self.stream_name {
                if !stream_name.is_empty() {
                    query.push_str(&format!(" AND stream_name = '{}'", stream_name));
                }
            }
            if let Some(user_email) = self.user_email {
                if !user_email.is_empty() {
                    query.push_str(&format!(" AND user_email = '{}'", user_email));
                }
            }
            if let Some(trace_id) = self.trace_id {
                if !trace_id.is_empty() {
                    query.push_str(&format!(" AND trace_id = '{}'", trace_id));
                }
            }

            query
        }
    }

    #[cfg(test)]
    mod tests {
        use super::SearchHistoryQueryBuilder;
        const SEARCH_STREAM_NAME: &str = "usage";

        #[test]
        fn test_empty_query() {
            let query = SearchHistoryQueryBuilder::new().build(SEARCH_STREAM_NAME);
            assert_eq!(query, "SELECT * FROM usage WHERE event='Search'");
        }

        #[test]
        fn test_with_org_id() {
            let query = SearchHistoryQueryBuilder::new()
                .with_org_id(&Some("org123".to_string()))
                .build(SEARCH_STREAM_NAME);
            assert_eq!(
                query,
                "SELECT * FROM usage WHERE event='Search' AND org_id = 'org123'"
            );
        }

        #[test]
        fn test_with_stream_type() {
            let query = SearchHistoryQueryBuilder::new()
                .with_stream_type(&Some("logs".to_string()))
                .build(SEARCH_STREAM_NAME);
            assert_eq!(
                query,
                "SELECT * FROM usage WHERE event='Search' AND stream_type = 'logs'"
            );
        }

        #[test]
        fn test_with_stream_name() {
            let query = SearchHistoryQueryBuilder::new()
                .with_stream_name(&Some("streamA".to_string()))
                .build(SEARCH_STREAM_NAME);
            assert_eq!(
                query,
                "SELECT * FROM usage WHERE event='Search' AND stream_name = 'streamA'"
            );
        }

        #[test]
        fn test_with_user_email() {
            let query = SearchHistoryQueryBuilder::new()
                .with_user_email(&Some("user123@gmail.com".to_string()))
                .build(SEARCH_STREAM_NAME);
            assert_eq!(
                query,
                "SELECT * FROM usage WHERE event='Search' AND user_email = 'user123@gmail.com'"
            );
        }

        #[test]
        fn test_with_trace_id() {
            let query = SearchHistoryQueryBuilder::new()
                .with_trace_id(&Some("trace123".to_string()))
                .build(SEARCH_STREAM_NAME);
            assert_eq!(
                query,
                "SELECT * FROM usage WHERE event='Search' AND trace_id = 'trace123'"
            );
        }

        #[test]
        fn test_combined_query() {
            let query = SearchHistoryQueryBuilder::new()
                .with_org_id(&Some("org123".to_string()))
                .with_stream_type(&Some("logs".to_string()))
                .with_stream_name(&Some("streamA".to_string()))
                .with_user_email(&Some("user123@gmail.com".to_string()))
                .with_trace_id(&Some("trace123".to_string()))
                .build(SEARCH_STREAM_NAME);

            let expected_query = "SELECT * FROM usage WHERE event='Search' \
            AND org_id = 'org123' \
            AND stream_type = 'logs' \
            AND stream_name = 'streamA' \
            AND user_email = 'user123@gmail.com' \
            AND trace_id = 'trace123'";

            assert_eq!(query, expected_query);
        }

        #[test]
        fn test_partial_query() {
            let query = SearchHistoryQueryBuilder::new()
                .with_org_id(&Some("org123".to_string()))
                .with_user_email(&Some("user123@gmail.com".to_string()))
                .build(SEARCH_STREAM_NAME);

            let expected_query = "SELECT * FROM usage WHERE event='Search' \
            AND org_id = 'org123' \
            AND user_email = 'user123@gmail.com'";

            assert_eq!(query, expected_query);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StreamResponses {
    // Original variant - to be deprecated but kept for backward compatibility
    SearchResponse {
        results: Response,
        streaming_aggs: bool,
        time_offset: TimeOffset,
    },
    // New focused variants
    SearchResponseMetadata {
        results: Response,
        streaming_aggs: bool,
        time_offset: TimeOffset,
    },
    SearchResponseHits {
        hits: Vec<json::Value>,
    },
    Progress {
        percent: usize,
    },
    Error {
        code: u16,
        message: String,
        error_detail: Option<String>,
    },
    Done,
    Cancelled,
}

/// An iterator that yields formatted chunks from a StreamResponse
pub struct StreamResponseChunks {
    /// The inner iterator for search responses with multiple chunks
    chunks_iter: Option<Box<dyn Iterator<Item = Result<BytesImpl, std::io::Error>> + Send>>,
    /// Single chunk for simple responses
    single_chunk: Option<Result<BytesImpl, std::io::Error>>,
}

impl Iterator for StreamResponseChunks {
    type Item = Result<BytesImpl, std::io::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(iter) = &mut self.chunks_iter {
            iter.next()
        } else {
            self.single_chunk.take()
        }
    }
}

impl StreamResponses {
    /// Convert a response to an iterator of formatted chunks
    /// For SearchResponse, this will apply the ResponseChunkIterator to break it into multiple
    /// chunks For other response types, this will return an iterator with a single chunk
    pub fn to_chunks(&self) -> StreamResponseChunks {
        // Helper function to format event data
        let format_event = |event_type: &str, data: &str| -> BytesImpl {
            let formatted = format!("event: {}\ndata: {}\n\n", event_type, data);
            BytesImpl::from(formatted.into_bytes())
        };

        match self {
            // Handle search responses with chunking
            StreamResponses::SearchResponse {
                results,
                streaming_aggs,
                time_offset,
            } => {
                log::info!(
                    "[HTTP2_STREAM] Chunking search response with {} hits using ResponseChunkIterator",
                    results.hits.len()
                );

                // Create the iterator
                let iterator = ResponseChunkIterator::new(
                    results.clone(),
                    None, // Use configured chunk size from environment
                );

                // Add a log message to show the chunk size being used
                log::info!(
                    "[HTTP2_STREAM] Using chunk size of {}MB from configuration",
                    get_config().websocket.streaming_response_chunk_size
                );

                // Capture needed values for the closure
                let streaming_aggs = *streaming_aggs;
                let time_offset = time_offset.clone();

                // Create an iterator that maps each chunk to a formatted BytesImpl
                let chunks_iter = iterator.map(move |chunk| {
                    let (event_type, data) = match chunk {
                        ResponseChunk::Metadata { response } => {
                            // Add streaming_aggs and time_offset from the original response
                            let metadata = StreamResponses::SearchResponseMetadata {
                                results: *response,
                                streaming_aggs,
                                time_offset: time_offset.clone(),
                            };
                            let data = serde_json::to_string(&metadata).unwrap_or_else(|_| {
                                log::error!("Failed to serialize metadata: {:?}", metadata);
                                String::new()
                            });
                            ("search_response_metadata", data)
                        }
                        ResponseChunk::Hits { hits } => {
                            let data =
                                serde_json::to_string(&StreamResponses::SearchResponseHits {
                                    hits,
                                })
                                .unwrap_or_else(|e| {
                                    log::error!("Failed to serialize hits: {e}");
                                    String::new()
                                });
                            ("search_response_hits", data)
                        }
                    };

                    // Format and encode the chunk
                    Ok(format_event(event_type, &data))
                });

                StreamResponseChunks {
                    chunks_iter: Some(Box::new(chunks_iter)),
                    single_chunk: None,
                }
            }

            // Handle other response types with a single chunk
            StreamResponses::SearchResponseMetadata { .. } => {
                let data = serde_json::to_string(self).unwrap_or_default();
                let bytes = format_event("search_response_metadata", &data);
                StreamResponseChunks {
                    chunks_iter: None,
                    single_chunk: Some(Ok(bytes)),
                }
            }
            StreamResponses::SearchResponseHits { .. } => {
                let data = serde_json::to_string(self).unwrap_or_default();
                let bytes = format_event("search_response_hits", &data);
                StreamResponseChunks {
                    chunks_iter: None,
                    single_chunk: Some(Ok(bytes)),
                }
            }
            StreamResponses::Progress { .. } => {
                let data = serde_json::to_string(self).unwrap_or_default();
                let bytes = format_event("progress", &data);
                StreamResponseChunks {
                    chunks_iter: None,
                    single_chunk: Some(Ok(bytes)),
                }
            }
            StreamResponses::Error { .. } => {
                let data = serde_json::to_string(self).unwrap_or_default();
                let bytes = format_event("error", &data);
                StreamResponseChunks {
                    chunks_iter: None,
                    single_chunk: Some(Ok(bytes)),
                }
            }
            StreamResponses::Done => {
                let bytes = BytesImpl::from("data: [[DONE]]\n\n");
                StreamResponseChunks {
                    chunks_iter: None,
                    single_chunk: Some(Ok(bytes)),
                }
            }
            StreamResponses::Cancelled => {
                let bytes = BytesImpl::from("data: [[CANCELLED]]\n\n");
                StreamResponseChunks {
                    chunks_iter: None,
                    single_chunk: Some(Ok(bytes)),
                }
            }
        }
    }
}
