// Copyright 2023 OpenObserve Inc.
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

import {
  ref,
  watch,
  reactive,
  toRefs,
  onMounted,
  onUnmounted,
  toRaw,
} from "vue";
import queryService from "../../services/search";
import { useStore } from "vuex";
import { addLabelToPromQlQuery } from "@/utils/query/promQLUtils";
import { addLabelsToSQlQuery } from "@/utils/query/sqlUtils";
import { getStreamFromQuery } from "@/utils/query/sqlUtils";
import {
  formatInterval,
  formatRateInterval,
  getTimeInSecondsBasedOnUnit,
} from "@/utils/dashboard/variables/variablesUtils";
import {
  b64EncodeUnicode,
  generateTraceContext,
  isWebSocketEnabled,
  isStreamingEnabled,
  escapeSingleQuotes,
} from "@/utils/zincutils";
import { usePanelCache } from "./usePanelCache";
import { isEqual, omit } from "lodash-es";
import { convertOffsetToSeconds } from "@/utils/dashboard/convertDataIntoUnitValue";
import useSearchWebSocket from "@/composables/useSearchWebSocket";
import { useAnnotations } from "./useAnnotations";
import useHttpStreamingSearch from "../useStreamingSearch";

/**
 * debounce time in milliseconds for panel data loader
 */
const PANEL_DATA_LOADER_DEBOUNCE_TIME = 50;

const adjustTimestampByTimeRangeGap = (
  timestamp: number,
  timeRangeGapSeconds: number,
) => {
  return timestamp - timeRangeGapSeconds * 1000;
};

export const usePanelDataLoader = (
  panelSchema: any,
  selectedTimeObj: any,
  variablesData: any,
  chartPanelRef: any,
  forceLoad: any,
  searchType: any,
  dashboardId: any,
  folderId: any,
  reportId: any,
) => {
  const log = (...args: any[]) => {
    // if (true) {
    //   console.log(panelSchema?.value?.title + ": ", ...args);
    // }
  };
  let runCount = 0;

  const store = useStore();

  const {
    fetchQueryDataWithWebSocket,
    sendSearchMessageBasedOnRequestId,
    cancelSearchQueryBasedOnRequestId,
    cleanUpListeners,
  } = useSearchWebSocket();

  const {
    fetchQueryDataWithHttpStream,
    cancelStreamQueryBasedOnRequestId,
    closeStreamWithError,
    closeStream,
    resetAuthToken,
  } = useHttpStreamingSearch();

  const { refreshAnnotations } = useAnnotations(
    store.state.selectedOrganization.identifier,
    dashboardId?.value,
    panelSchema.value.id,
  );

  const shouldFetchAnnotations = () => {
    return [
      "area",
      "area-stacked",
      "bar",
      "h-bar",
      "line",
      "scatter",
      "stacked",
      "h-stacked",
    ].includes(panelSchema.value.type);
  };

  const getFallbackOrderByCol = () => {
    // from panelSchema, get first x axis field alias
    if (panelSchema?.value?.queries?.[0]?.fields?.x) {
      return panelSchema.value?.queries[0]?.fields?.x?.[0]?.alias ?? null;
    }
    return null;
  };

  /**
   * Calculate cache key for panel
   * @returns cache key
   */
  const getCacheKey = () => ({
    panelSchema: toRaw(panelSchema.value),
    variablesData: JSON.parse(
      JSON.stringify([
        ...(getDependentVariablesData() || []),
        ...(getDynamicVariablesData() || []),
      ]),
    ),
    forceLoad: toRaw(forceLoad.value),
    // searchType: toRaw(searchType.value),
    dashboardId: toRaw(dashboardId?.value),
    folderId: toRaw(folderId?.value),
  });

  const { getPanelCache, savePanelCache } = usePanelCache(
    folderId?.value,
    dashboardId?.value,
    panelSchema.value.id,
  );

  const state = reactive({
    data: [] as any,
    loading: false,
    errorDetail: {
      message: "",
      code: "",
    },
    metadata: {
      queries: [] as any,
    },
    annotations: [] as any,
    resultMetaData: [] as any,
    lastTriggeredAt: null as any,
    isCachedDataDifferWithCurrentTimeRange: false,
    searchRequestTraceIds: <string[]>[],
    isOperationCancelled: false,
    loadingTotal: 0,
    loadingCompleted: 0,
    loadingProgressPercentage: 0,
    isPartialData: false,
  });

  // observer for checking if panel is visible on the screen
  let observer: any = null;

  // is panel currently visible or not
  const isVisible: any = ref(false);

  const saveCurrentStateToCache = async () => {
    await savePanelCache(
      getCacheKey(),
      { ...toRaw(state) },
      {
        start_time: selectedTimeObj?.value?.start_time?.getTime(),
        end_time: selectedTimeObj?.value?.end_time?.getTime(),
      },
    );
  };

  // currently dependent variables data
  let currentDependentVariablesData = variablesData?.value?.values
    ? JSON.parse(
        JSON.stringify(
          variablesData.value?.values
            ?.filter((it: any) => it.type != "dynamic_filters") // ad hoc filters are not considered as dependent filters as they are globally applied
            ?.filter((it: any) => {
              const regexForVariable = new RegExp(
                `.*\\$\\{?${it.name}(?::(csv|pipe|doublequote|singlequote))?}?.*`,
              );

              return panelSchema.value.queries
                ?.map((q: any) => regexForVariable.test(q?.query))
                ?.includes(true);
            }),
        ),
      )
    : [];

  let currentDynamicVariablesData = variablesData?.value?.values
    ? JSON.parse(
        JSON.stringify(
          variablesData.value?.values
            ?.filter((it: any) => it.type === "dynamic_filters")
            ?.map((it: any) => it?.value)
            ?.flat()
            ?.filter((it: any) => it?.operator && it?.name && it?.value),
        ),
      )
    : [];
  // let currentAdHocVariablesData: any = null;

  let abortController = new AbortController();

  // [START] --------- New Functions ------------------------------------------

  // This function acts as a debounce and helps to reduce to continue execution
  // with old values when too many frequent updates are made to schema
  const waitForTimeout = (signal: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      // wait for timeout
      // and abort if abort signal received
      const timeoutId = setTimeout(resolve, PANEL_DATA_LOADER_DEBOUNCE_TIME);

      // Listen to the abort signal
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        reject(new Error("Aborted waiting for loading"));
      });
    });
  };

  // an async function that waits for the panel to become visible
  const waitForThePanelToBecomeVisible = (signal: any) => {
    return new Promise<void>((resolve, reject) => {
      // Immediately resolve if forceLoad is true
      if (forceLoad.value == true) {
        resolve();
        return;
      }
      // Immediately resolve if isVisible is already true
      if (isVisible.value) {
        resolve();
        return;
      }

      // Watch for changes in isVisible
      const stopWatching = watch(isVisible, (newValue) => {
        if (newValue) {
          resolve();
          stopWatching(); // Stop watching once isVisible is true
        }
      });

      // Listen to the abort signal
      signal.addEventListener("abort", () => {
        stopWatching(); // Stop watching on abort
        reject(new Error("Aborted waiting for loading"));
      });
    });
  };

  // an async function that waits for the variables to load
  const waitForTheVariablesToLoad = (signal: any) => {
    return new Promise<void>((resolve, reject) => {
      log("waitForTheVariablesToLoad: entering...");
      // Immediately resolve if variables are already loaded
      if (ifPanelVariablesCompletedLoading()) {
        log("waitForTheVariablesToLoad: variables are already loaded");
        resolve();
        return;
      }

      // Watch for changes in isVisible
      const stopWatching = watch(
        () => variablesData.value?.values,
        () => {
          if (ifPanelVariablesCompletedLoading()) {
            log(
              "waitForTheVariablesToLoad: variables are loaded (inside watch)",
            );
            resolve();
            stopWatching(); // Stop watching once isVisible is true
          }
        },
      );

      // Listen to the abort signal
      signal.addEventListener("abort", () => {
        stopWatching(); // Stop watching on abort
        reject(new Error("Aborted waiting for loading"));
      });
    });
  };

  /**
   * Call a function with an AbortController, and propagate the abort
   * signal to the function. This allows the function to be cancelled
   * when the AbortController is aborted.
   *
   * @param fn The function to call
   * @param signal The AbortSignal to use
   * @returns A promise that resolves with the result of the function, or
   * rejects with an error if the function is cancelled or throws an error
   */
  const callWithAbortController = async <T>(
    fn: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const result = fn();

      // Listen to the abort signal and reject the promise if it is
      // received
      signal.addEventListener("abort", () => {
        reject();
      });

      // Handle the result of the function
      result
        .then((res) => {
          resolve(res);
        })
        .catch((error) => {
          reject(error);
        });
    });
  };

  const cancelQueryAbort = () => {
    state.loading = false;
    state.isOperationCancelled = true;
    state.isPartialData = true; // Set to true when cancelled

    if (
      isStreamingEnabled(store.state) &&
      state.searchRequestTraceIds?.length > 0
    ) {
      try {
        state.searchRequestTraceIds.forEach((traceId) => {
          cancelStreamQueryBasedOnRequestId({
            trace_id: traceId,
            org_id: store?.state?.selectedOrganization?.identifier,
          });
        });
      } catch (error) {
        console.error("Error during Stream cleanup:", error);
      } finally {
        state.searchRequestTraceIds = [];
      }
    }

    if (
      isWebSocketEnabled(store.state) &&
      state.searchRequestTraceIds?.length > 0
    ) {
      try {
        state.searchRequestTraceIds.forEach((traceId) => {
          cancelSearchQueryBasedOnRequestId({
            trace_id: traceId,
            org_id: store?.state?.selectedOrganization?.identifier,
          });
        });
      } catch (error) {
        console.error("Error during WebSocket cleanup:", error);
      } finally {
        state.searchRequestTraceIds = [];
      }
    }
    if (abortController) {
      abortController?.abort();
    }
    saveCurrentStateToCache();
  };

  const getHistogramSearchRequest = async (
    query: string,
    it: any,
    startISOTimestamp: string,
    endISOTimestamp: string,
    histogramInterval: number | null | undefined,
  ) => {
    return {
      sql: query,
      query_fn: it.vrlFunctionQuery
        ? b64EncodeUnicode(it.vrlFunctionQuery.trim())
        : null,
      sql_mode: "full",
      // if i == 0 ? then do gap of 7 days
      start_time: startISOTimestamp,
      end_time: endISOTimestamp,
      size: -1,
      histogram_interval: histogramInterval ?? undefined,
    };
  };

  const getDataThroughPartitions = async (
    query: string,
    metadata: any,
    it: any,
    startISOTimestamp: string,
    endISOTimestamp: string,
    pageType: string,
    abortControllerRef: AbortController,
  ) => {
    const { traceparent, traceId } = generateTraceContext();
    addTraceId(traceId);

    state.loadingTotal = 0;
    state.loadingCompleted = 0;
    state.loadingProgressPercentage = 0;

    try {
      // partition api call
      const res: any = await callWithAbortController(
        async () =>
          queryService.partition({
            org_identifier: store.state.selectedOrganization.identifier,
            query: {
              sql: store.state.zoConfig.sql_base64_enabled
                ? b64EncodeUnicode(query)
                : query,
              // pass encodig if enabled,
              // make sure that `encoding: null` is not being passed, that's why used object extraction logic
              ...(store.state.zoConfig.sql_base64_enabled
                ? { encoding: "base64" }
                : {}),
              query_fn: it.vrlFunctionQuery
                ? b64EncodeUnicode(it.vrlFunctionQuery.trim())
                : null,
              sql_mode: "full",
              start_time: startISOTimestamp,
              end_time: endISOTimestamp,
              size: -1,
              // pass always true for streaming_output
              streaming_output: true,
            },
            page_type: pageType,
            traceparent,
          }),
        abortControllerRef.signal,
      );

      // if aborted, return
      if (abortControllerRef?.signal?.aborted) {
        // Set partial data when partition API call is interrupted
        state.isPartialData = true;
        // Save current state to cache with partial data flag
        saveCurrentStateToCache();
        return;
      }

      // request order_by
      const order_by = res?.data?.order_by ?? "asc";

      // partition array from api response
      const partitionArr = res?.data?.partitions ?? [];

      // Set total steps: number of partitions only (excluding the initial partition API call)
      const totalSteps = partitionArr.length;
      state.loadingTotal = totalSteps;

      // Reset loading completed and progress since we're not counting the partition API call
      state.loadingCompleted = 0;
      state.loadingProgressPercentage = 0;

      // always sort partitions in descending order
      partitionArr.sort((a: any, b: any) => a[0] - b[0]);

      // max_query_range for current query stream
      const max_query_range = res?.data?.max_query_range ?? 0;

      // histogram_interval from partition api response
      const histogramInterval = res?.data?.histogram_interval ?? undefined;

      // Add empty objects to state.resultMetaData for the results of this query
      state.data.push([]);
      state.resultMetaData.push({});

      const currentQueryIndex = state.data.length - 1;

      // remaining query range
      let remainingQueryRange = max_query_range;

      // loop on all partitions and call search api for each partition
      for (let i = partitionArr.length - 1; i >= 0; i--) {
        state.loading = true;

        const partition = partitionArr[i];

        if (abortControllerRef?.signal?.aborted) {
          break;
        }
        const { traceparent, traceId } = generateTraceContext();
        addTraceId(traceId);

        try {
          const searchRes = await callWithAbortController(
            async () =>
              await queryService.search(
                {
                  org_identifier: store.state.selectedOrganization.identifier,
                  query: {
                    query: {
                      ...(await getHistogramSearchRequest(
                        query,
                        it,
                        partition[0],
                        partition[1],
                        histogramInterval,
                      )),
                      streaming_output: res?.data?.streaming_aggs ?? false,
                      streaming_id: res?.data?.streaming_id ?? null,
                    },
                    // pass encodig if enabled,
                    // make sure that `encoding: null` is not being passed, that's why used object extraction logic
                    ...(store.state.zoConfig.sql_base64_enabled
                      ? { encoding: "base64" }
                      : {}),
                  },
                  page_type: pageType,
                  traceparent,
                  dashboard_id: dashboardId?.value,
                  folder_id: folderId?.value,
                },
                searchType.value ?? "dashboards",
              ),
            abortControllerRef.signal,
          );

          // Update the progress after each partition completes
          state.loadingCompleted = state.loadingCompleted + 1;
          // Calculate progress in 0-100 format
          state.loadingProgressPercentage = Math.round(
            (state.loadingCompleted / totalSteps) * 100,
          );

          // remove past error detail
          state.errorDetail = {
            message: "",
            code: "",
          };

          // Removing below part to allow rendering chart if the error is a function error
          // if there is an function error and which not related to stream range, throw error
          // if (
          //   searchRes.data.function_error &&
          //   searchRes.data.is_partial != true
          // ) {
          //   // abort on unmount
          //   if (abortControllerRef) {
          //     // this will stop partition api call
          //     abortControllerRef?.abort();
          //   }

          //   // throw error
          //   throw new Error(`Function error: ${searchRes.data.function_error}`);
          // }

          // if the query is aborted or the response is partial, break the loop
          if (abortControllerRef?.signal?.aborted) {
            break;
          }

          if (res?.data?.streaming_aggs) {
            state.data[currentQueryIndex] = [...searchRes.data.hits];
          }
          // if order by is desc, append new partition response at end
          else if (order_by.toLowerCase() === "desc") {
            state.data[currentQueryIndex] = [
              ...(state.data[currentQueryIndex] ?? []),
              ...searchRes.data.hits,
            ];
          } else {
            // else append new partition response at start
            state.data[currentQueryIndex] = [
              ...searchRes.data.hits,
              ...(state.data[currentQueryIndex] ?? []),
            ];
          }

          // update result metadata
          state.resultMetaData[currentQueryIndex] = searchRes.data ?? {};

          if (searchRes.data.is_partial == true) {
            // set the new start time as the start time of query
            state.resultMetaData[currentQueryIndex].new_end_time =
              endISOTimestamp;

            // need to break the loop, save the cache
            // this is async task, which will be executed in background(await is not required)
            saveCurrentStateToCache();

            break;
          }

          if (max_query_range != 0) {
            // calculate the current partition time range
            // convert timerange from milliseconds to hours
            const timeRange = (partition[1] - partition[0]) / 3600000000;

            // get result cache ratio(it will be from 0 to 100)
            const resultCacheRatio = searchRes.data.result_cache_ratio ?? 0;

            // calculate the remaining query range
            // remaining query range = remaining query range - queried time range for the current partition
            // queried time range = time range * ((100 - result cache ratio) / 100)

            const queriedTimeRange =
              timeRange * ((100 - resultCacheRatio) / 100);

            remainingQueryRange = remainingQueryRange - queriedTimeRange;

            // if the remaining query range is less than 0, break the loop
            // we exceeded the max query range
            if (remainingQueryRange < 0) {
              // set that is_partial to true if it is not last partition which we need to call
              if (i != 0) {
                // set that is_partial to true
                state.resultMetaData[currentQueryIndex].is_partial = true;
                // set function error
                state.resultMetaData[currentQueryIndex].function_error =
                  `Query duration is modified due to query range restriction of ${max_query_range} hours`;
                // set the new start time and end time
                state.resultMetaData[currentQueryIndex].new_end_time =
                  endISOTimestamp;

                // set the new start time as the start time of query
                state.resultMetaData[currentQueryIndex].new_start_time =
                  partition[0];

                // need to break the loop, save the cache
                // this is async task, which will be executed in background(await is not required)
                saveCurrentStateToCache();

                break;
              }
            }
          }
        } finally {
          removeTraceId(traceId);
        }

        if (i == 0) {
          // if it is last partition, cache the result
          // this is async task, which will be executed in background(await is not required)
          saveCurrentStateToCache();
        }
      }
    } catch (error) {
      // Process API error for "sql"
      processApiError(error, "sql");
      return { result: null, metadata: metadata };
    } finally {
      // set loading to false
      state.loading = false;
      removeTraceId(traceId);
    }
  };

  const handleHistogramResponse = async (payload: any, searchRes: any) => {
    // remove past error detail
    state.errorDetail = {
      message: "",
      code: "",
    };

    // is streaming aggs
    const streaming_aggs = searchRes?.content?.streaming_aggs ?? false;

    // if streaming aggs, replace the state data
    if (streaming_aggs) {
      state.data[payload?.meta?.currentQueryIndex] = [
        ...(searchRes?.content?.results?.hits ?? {}),
      ];
    }
    // if order by is desc, append new partition response at end
    else if (searchRes?.content?.results?.order_by?.toLowerCase() === "asc") {
      // else append new partition response at start
      state.data[payload?.meta?.currentQueryIndex] = [
        ...(searchRes?.content?.results?.hits ?? {}),
        ...(state.data[payload?.meta?.currentQueryIndex] ?? []),
      ];
    } else {
      state.data[payload?.meta?.currentQueryIndex] = [
        ...(state.data[payload?.meta?.currentQueryIndex] ?? []),
        ...(searchRes?.content?.results?.hits ?? {}),
      ];
    }

    // update result metadata
    state.resultMetaData[payload?.meta?.currentQueryIndex] =
      searchRes?.content?.results ?? {};

    // If we have data and loading is complete, set isPartialData to false
    if (
      state.data[payload?.meta?.currentQueryIndex]?.length > 0 &&
      !state.loading
    ) {
      state.isPartialData = false;
    }
  };

  const handleStreamingHistogramMetadata = (payload: any, searchRes: any) => {
    // update result metadata
    state.resultMetaData[payload?.meta?.currentQueryIndex] = {
      ...(searchRes?.content ?? {}),
      ...(searchRes?.content?.results ?? {}),
    };
  };

  const handleStreamingHistogramHits = (payload: any, searchRes: any) => {
    // remove past error detail
    state.errorDetail = {
      message: "",
      code: "",
    };

    // is streaming aggs
    const streaming_aggs =
      state?.resultMetaData?.[payload?.meta?.currentQueryIndex]
        ?.streaming_aggs ?? false;

    // if streaming aggs, replace the state data
    if (streaming_aggs) {
      state.data[payload?.meta?.currentQueryIndex] = [
        ...(searchRes?.content?.results?.hits ?? {}),
      ];
    }
    // if order by is desc, append new partition response at end
    else if (
      state?.resultMetaData?.[
        payload?.meta?.currentQueryIndex
      ]?.order_by?.toLowerCase() === "asc"
    ) {
      // else append new partition response at start
      state.data[payload?.meta?.currentQueryIndex] = [
        ...(searchRes?.content?.results?.hits ?? {}),
        ...(state.data[payload?.meta?.currentQueryIndex] ?? []),
      ];
    } else {
      state.data[payload?.meta?.currentQueryIndex] = [
        ...(state.data[payload?.meta?.currentQueryIndex] ?? []),
        ...(searchRes?.content?.results?.hits ?? {}),
      ];
    }

    // update result metadata
    state.resultMetaData[payload?.meta?.currentQueryIndex].hits =
      searchRes?.content?.results?.hits ?? {};
  };

  // Limit, aggregation, vrl function, pagination, function error and query error
  const handleSearchResponse = (payload: any, response: any) => {
    try {
      if (response.type === "search_response_metadata") {
        handleStreamingHistogramMetadata(payload, response);
        saveCurrentStateToCache();
      }

      if (response.type === "search_response_hits") {
        handleStreamingHistogramHits(payload, response);
        saveCurrentStateToCache();
      }

      if (response.type === "search_response") {
        handleHistogramResponse(payload, response);
        saveCurrentStateToCache();
      }

      if (response.type === "error") {
        state.loading = false;
        state.loadingTotal = 0;
        state.loadingCompleted = 0;
        state.loadingProgressPercentage = 0;
        state.isOperationCancelled = false;
        processApiError(response?.content, "sql");
      }

      if (response.type === "end") {
        state.loading = false;
        state.loadingTotal = 0;
        state.loadingCompleted = 0;
        state.loadingProgressPercentage = 100; // Set to 100% when complete
        state.isOperationCancelled = false;
        state.isPartialData = false; // Explicitly set to false when complete
        saveCurrentStateToCache();
      }

      if (response.type === "event_progress") {
        state.loadingProgressPercentage = response?.content?.percent ?? 0;
        state.isPartialData = true;
        saveCurrentStateToCache();
      }
    } catch (error: any) {
      state.loading = false;
      state.isOperationCancelled = false;
      state.loadingTotal = 0;
      state.loadingCompleted = 0;
      state.loadingProgressPercentage = 0;
      state.errorDetail = {
        message: error?.message || "Unknown error in search response",
        code: error?.code ?? "",
      };
    }
  };

  const sendSearchMessage = async (payload: any) => {
    // check if query is already canceled, if it is, close the socket
    if (state.isOperationCancelled) {
      state.isOperationCancelled = false;

      // clean up the listeners
      cleanUpListeners(payload.traceId);

      return;
    }

    sendSearchMessageBasedOnRequestId({
      type: "search",
      content: {
        trace_id: payload.traceId,
        payload: {
          query: {
            ...(await getHistogramSearchRequest(
              payload.queryReq.query,
              payload.queryReq.it,
              payload.queryReq.startISOTimestamp,
              payload.queryReq.endISOTimestamp,
              null,
            )),
          },
          // pass encodig if enabled,
          // make sure that `encoding: null` is not being passed, that's why used object extraction logic
          ...(store.state.zoConfig.sql_base64_enabled
            ? { encoding: "base64" }
            : {}),
        },
        stream_type: payload.pageType,
        search_type: searchType.value ?? "dashboards",
        org_id: store?.state?.selectedOrganization?.identifier,
        use_cache: (window as any).use_cache ?? true,
        dashboard_id: dashboardId?.value,
        folder_id: folderId?.value,
        fallback_order_by_col: getFallbackOrderByCol(),
      },
    });
  };

  const handleSearchClose = (payload: any, response: any) => {
    removeTraceId(payload?.traceId);

    if (response.type === "error") {
      processApiError(response?.content, "sql");
    }

    const errorCodes = [1001, 1006, 1010, 1011, 1012, 1013];

    if (errorCodes.includes(response.code)) {
      handleSearchError(payload, {
        content: {
          message:
            "WebSocket connection terminated unexpectedly. Please check your network and try again",
          trace_id: payload.traceId,
          code: response.code,
          error_detail: "",
        },
      });
    }

    // set loading to false
    state.loading = false;
    state.isOperationCancelled = false;
    state.isPartialData = false;
    // save current state to cache
    // this is async task, which will be executed in background(await is not required)
    saveCurrentStateToCache();
  };

  const handleSearchReset = (payload: any, traceId?: string) => {
    // Save current state to cache
    saveCurrentStateToCache();
    loadData();
  };

  const handleSearchError = (payload: any, response: any) => {
    removeTraceId(payload.traceId);

    // set loading to false
    state.loading = false;
    state.loadingTotal = 0;
    state.loadingCompleted = 0;
    state.loadingProgressPercentage = 0;
    state.isOperationCancelled = false;

    processApiError(response?.content, "sql");
  };

  const shouldSkipSearchDueToEmptyVariables = () => {
    // Retrieve all variables data
    const allVars = [
      ...(getDependentVariablesData() || []),
      ...(getDynamicVariablesData() || []),
    ];

    // Identify variables with empty values
    const variablesToSkip = allVars
      .filter(
        (v) =>
          v.value === null ||
          v.value === undefined ||
          v.value === "" ||
          (Array.isArray(v.value) && v.value.length === 0),
      )
      .map((v) => v.name);

    // Log variables for which the API will be skipped
    variablesToSkip.forEach((variableName) => {
      state.loading = false;
    });

    // Return true if there are any variables to skip, indicating loading should be continued
    return variablesToSkip.length > 0;
  };

  const getDataThroughWebSocket = async (
    query: string,
    it: any,
    startISOTimestamp: string,
    endISOTimestamp: string,
    pageType: string,
    currentQueryIndex: number,
  ) => {
    try {
      const { traceId } = generateTraceContext();
      addTraceId(traceId);

      const payload: {
        queryReq: any;
        type: "search" | "histogram" | "pageCount" | "values";
        isPagination: boolean;
        traceId: string;
        org_id: string;
        pageType: string;
        meta: any;
      } = {
        queryReq: {
          query,
          it,
          startISOTimestamp,
          endISOTimestamp,
          currentQueryIndex,
          // pass encodig if enabled,
          // make sure that encoding: null is not being passed, that's why used object extraction logic
          ...(store.state.zoConfig.sql_base64_enabled
            ? { encoding: "base64" }
            : {}),
        },
        type: "histogram",
        isPagination: false,
        traceId,
        org_id: store?.state?.selectedOrganization?.identifier,
        pageType,
        meta: {
          currentQueryIndex,
        },
      };

      // Add guard here
      if (shouldSkipSearchDueToEmptyVariables()) {
        return;
      }
      fetchQueryDataWithWebSocket(payload, {
        open: sendSearchMessage,
        close: handleSearchClose,
        error: handleSearchError,
        message: handleSearchResponse,
        reset: handleSearchReset,
      });

      addTraceId(traceId);
    } catch (e: any) {
      state.errorDetail = {
        message: e?.message || e,
        code: e?.code ?? "",
      };
      state.loading = false;
      state.isOperationCancelled = false;
    }
  };

  const getDataThroughStreaming = async (
    query: string,
    it: any,
    startISOTimestamp: string,
    endISOTimestamp: string,
    pageType: string,
    currentQueryIndex: number,
    abortControllerRef: any,
  ) => {
    try {
      const { traceId } = generateTraceContext();

      const payload: {
        queryReq: any;
        type: "search" | "histogram" | "pageCount";
        isPagination: boolean;
        traceId: string;
        org_id: string;
        pageType: string;
        searchType: string;
        meta: any;
      } = {
        queryReq: {
          query: {
            ...(await getHistogramSearchRequest(
              query,
              it,
              startISOTimestamp,
              endISOTimestamp,
              null,
            )),
          },
        },
        type: "histogram",
        isPagination: false,
        traceId,
        org_id: store?.state?.selectedOrganization?.identifier,
        pageType,
        searchType: searchType.value ?? "dashboards",
        meta: {
          currentQueryIndex,
          dashboard_id: dashboardId?.value,
          folder_id: folderId?.value,
          fallback_order_by_col: getFallbackOrderByCol(),
        },
      };

      // type: "search",
      // content: {
      //   trace_id: payload.traceId,
      //   payload: {
      //     query: await getHistogramSearchRequest(
      //       payload.queryReq.query,
      //       payload.queryReq.it,
      //       payload.queryReq.startISOTimestamp,
      //       payload.queryReq.endISOTimestamp,
      //       null,
      //     ),
      //   },
      //   stream_type: payload.pageType,
      //   search_type: searchType.value ?? "dashboards",
      //   org_id: store?.state?.selectedOrganization?.identifier,
      //   use_cache: (window as any).use_cache ?? true,
      //   dashboard_id: dashboardId?.value,
      //   folder_id: folderId?.value,
      //   fallback_order_by_col: getFallbackOrderByCol(),
      // },

      // if aborted, return
      if (abortControllerRef?.signal?.aborted) {
        // Set partial data flag on abort
        state.isPartialData = true;
        // Save current state to cache
        saveCurrentStateToCache();
        return;
      }

      // Add guard here
      if (shouldSkipSearchDueToEmptyVariables()) {
        return;
      }

      fetchQueryDataWithHttpStream(payload, {
        data: handleSearchResponse,
        error: handleSearchError,
        complete: handleSearchClose,
        reset: handleSearchReset,
      });

      addTraceId(traceId);
    } catch (e: any) {
      state.errorDetail = {
        message: e?.message || e,
        code: e?.code ?? "",
      };
      state.loading = false;
      state.isOperationCancelled = false;
    }
  };

  const loadData = async () => {
    // Only reset isPartialData if we're starting a fresh load and not restoring from cache
    if (runCount > 0 && !state.isOperationCancelled) {
      state.isPartialData = false;
    }

    try {
      log("loadData: entering...");
      state.loadingTotal = 0;
      state.loadingCompleted = 0;
      state.loadingProgressPercentage = 0;
      // Check and abort the previous call if necessary
      if (abortController) {
        log("loadData: aborting previous function call (if any)");
        abortController.abort();
      }

      // Create a new AbortController for the new operation
      abortController = new AbortController();
      window.addEventListener("cancelQuery", cancelQueryAbort);
      // Checking if there are queries to execute
      if (!panelSchema.value.queries?.length || !hasAtLeastOneQuery()) {
        log("loadData: there are no queries to execute");
        state.loading = false;
        state.isOperationCancelled = false;
        state.data = [];
        state.metadata = {
          queries: [],
        };
        state.resultMetaData = [];
        return;
      }

      log("loadData: now waiting for the timeout to avoid frequent updates");

      await waitForTimeout(abortController.signal);

      log("loadData: now waiting for the panel to become visible");

      state.lastTriggeredAt = new Date().getTime();

      if (runCount == 0) {
        log("loadData: panelcache: run count is 0");
        // restore from the cache and return
        const isRestoredFromCache = await restoreFromCache();
        log("loadData: panelcache: isRestoredFromCache", isRestoredFromCache);
        if (isRestoredFromCache) {
          state.loading = false;
          state.isOperationCancelled = false;
          log("loadData: panelcache: restored from cache");
          runCount++;
          return;
        }
      }

      // Wait for isVisible to become true
      await waitForThePanelToBecomeVisible(abortController.signal);

      log("loadData: now waiting for the variables to load");

      // Wait for variables to load
      await waitForTheVariablesToLoad(abortController.signal);

      log("loadData: good to go... starting query executions...");

      const timestamps = selectedTimeObj.value;
      let startISOTimestamp: any;
      let endISOTimestamp: any;
      if (
        timestamps?.start_time &&
        timestamps?.end_time &&
        timestamps.start_time != "Invalid Date" &&
        timestamps.end_time != "Invalid Date"
      ) {
        startISOTimestamp = new Date(
          timestamps.start_time.toISOString(),
        ).getTime();
        endISOTimestamp = new Date(timestamps.end_time.toISOString()).getTime();
      } else {
        return;
      }

      log(
        "loadData: panelcache: no cache restored, continue firing, runCount ",
        runCount,
      );

      runCount++;

      state.loading = true;
      state.isCachedDataDifferWithCurrentTimeRange = false;

      // remove past error detail
      state.errorDetail = {
        message: "",
        code: "",
      };

      // Check if the query type is "promql"
      if (panelSchema.value.queryType == "promql") {
        // Iterate through each query in the panel schema
        const queryPromises = panelSchema.value.queries?.map(
          async (it: any) => {
            const { query: query1, metadata: metadata1 } = replaceQueryValue(
              it.query,
              startISOTimestamp,
              endISOTimestamp,
              panelSchema.value.queryType,
            );

            const { query: query2, metadata: metadata2 } =
              await applyDynamicVariables(query1, panelSchema.value.queryType);

            const query = query2;
            const metadata = {
              originalQuery: it.query,
              query: query,
              startTime: startISOTimestamp,
              endTime: endISOTimestamp,
              queryType: panelSchema.value.queryType,
              variables: [...(metadata1 || []), ...(metadata2 || [])],
            };
            const { traceparent, traceId } = generateTraceContext();
            addTraceId(traceId);
            try {
              const res = await callWithAbortController(
                () =>
                  queryService.metrics_query_range({
                    org_identifier: store.state.selectedOrganization.identifier,
                    query: query,
                    start_time: startISOTimestamp,
                    end_time: endISOTimestamp,
                    step: panelSchema.value.config.step_value ?? "0",
                  }),
                abortController.signal,
              );

              state.errorDetail = {
                message: "",
                code: "",
              };
              return { result: res.data.data, metadata: metadata };
            } catch (error) {
              processApiError(error, "promql");
              return { result: null, metadata: metadata };
            } finally {
              removeTraceId(traceId);
            }
          },
        );
        // get annotations
        const annotationList = shouldFetchAnnotations()
          ? await refreshAnnotations(startISOTimestamp, endISOTimestamp)
          : [];

        // Wait for all query promises to resolve
        const queryResults: any = await Promise.all(queryPromises);
        state.loading = false;
        state.data = queryResults.map((it: any) => it?.result);
        state.metadata = {
          queries: queryResults.map((it: any) => it?.metadata),
        };
        state.annotations = annotationList || [];

        // this is async task, which will be executed in background(await is not required)
        saveCurrentStateToCache();
      } else {
        // copy of current abortController
        // which is used to check whether the current query has been aborted
        const abortControllerRef = abortController;

        try {
          // Call search API
          state.data = [];
          state.metadata = {
            queries: [],
          };
          state.resultMetaData = [];
          state.annotations = [];
          state.isOperationCancelled = false;

          // Get the page type from the first query in the panel schema
          const pageType = panelSchema.value.queries[0]?.fields?.stream_type;

          // Handle each query sequentially
          for (const [
            panelQueryIndex,
            it,
          ] of panelSchema.value.queries.entries()) {
            state.loading = true;

            if (it.config?.time_shift && it.config?.time_shift?.length > 0) {
              // convert time shift to milliseconds
              const timeShiftInMilliSecondsArray = it.config?.time_shift?.map(
                (it: any) => convertOffsetToSeconds(it.offSet, endISOTimestamp),
              );

              // append 0 seconds to the timeShiftInMilliSecondsArray at 0th index
              timeShiftInMilliSecondsArray.unshift({
                seconds: 0,
                periodAsStr: "",
              });

              const timeShiftQueries: any[] = [];

              // loop on all timeShiftInMilliSecondsArray
              for (let i = 0; i < timeShiftInMilliSecondsArray.length; i++) {
                const timeRangeGap = timeShiftInMilliSecondsArray[i];
                const { query: query1, metadata: metadata1 } =
                  replaceQueryValue(
                    it.query,
                    adjustTimestampByTimeRangeGap(
                      startISOTimestamp,
                      timeRangeGap.seconds,
                    ),
                    adjustTimestampByTimeRangeGap(
                      endISOTimestamp,
                      timeRangeGap.seconds,
                    ),
                    panelSchema.value.queryType,
                  );

                const { query: query2, metadata: metadata2 } =
                  await applyDynamicVariables(
                    query1,
                    panelSchema.value.queryType,
                  );
                const query = query2;
                const metadata: any = {
                  originalQuery: it.query,
                  query: query,
                  startTime: adjustTimestampByTimeRangeGap(
                    startISOTimestamp,
                    timeRangeGap.seconds,
                  ),
                  endTime: adjustTimestampByTimeRangeGap(
                    endISOTimestamp,
                    timeRangeGap.seconds,
                  ),
                  queryType: panelSchema.value.queryType,
                  variables: [...(metadata1 || []), ...(metadata2 || [])],
                  timeRangeGap: timeRangeGap,
                };

                // push metadata and searchRequestObj[which will be passed to search API]
                timeShiftQueries.push({
                  metadata,
                  searchRequestObj: {
                    sql: query,
                    start_time: adjustTimestampByTimeRangeGap(
                      startISOTimestamp,
                      timeRangeGap.seconds,
                    ),
                    end_time: adjustTimestampByTimeRangeGap(
                      endISOTimestamp,
                      timeRangeGap.seconds,
                    ),
                    query_fn: null,
                  },
                });
              }

              try {
                // get search queries
                const searchQueries = timeShiftQueries.map(
                  (it: any) => it.searchRequestObj,
                );

                const { traceparent, traceId } = generateTraceContext();
                addTraceId(traceId);
                // if aborted, return
                if (abortControllerRef?.signal?.aborted) {
                  return;
                }

                state.loading = true;

                try {
                  const searchRes = await callWithAbortController(
                    async () =>
                      await queryService.search(
                        {
                          org_identifier:
                            store.state.selectedOrganization.identifier,
                          query: {
                            query: {
                              sql: searchQueries,
                              query_fn: it.vrlFunctionQuery
                                ? b64EncodeUnicode(it.vrlFunctionQuery.trim())
                                : null,
                              sql_mode: "full",
                              start_time: startISOTimestamp,
                              end_time: endISOTimestamp,
                              per_query_response: true,
                              size: -1,
                            },
                          },
                          page_type: pageType,
                          traceparent,
                          dashboard_id: dashboardId?.value,
                          folder_id: folderId?.value,
                        },
                        searchType.value ?? "dashboards",
                      ),
                    abortControllerRef.signal,
                  );
                  // remove past error detail
                  state.errorDetail = {
                    message: "",
                    code: "",
                  };

                  // if there is an function error and which not related to stream range, throw error
                  if (
                    searchRes.data.function_error &&
                    searchRes.data.is_partial != true
                  ) {
                    // abort on unmount
                    if (abortControllerRef) {
                      // this will stop partition api call
                      abortControllerRef?.abort();
                    }

                    // throw error
                    throw new Error(
                      `Function error: ${searchRes.data.function_error}`,
                    );
                  }

                  // if the query is aborted or the response is partial, break the loop
                  if (abortControllerRef?.signal?.aborted) {
                    break;
                  }

                  for (
                    let i = 0;
                    i < timeShiftInMilliSecondsArray.length;
                    i++
                  ) {
                    state.data.push([]);
                    state.metadata.queries.push({});
                    state.resultMetaData.push({});

                    if (
                      searchRes?.data?.hits &&
                      Array.isArray(searchRes.data.hits[i])
                    ) {
                      state.data[i] = [...(searchRes.data.hits[i] ?? [])];
                    } else {
                      throw new Error(
                        "Invalid response format: Expected an array, but received an object. Please update your function.",
                      );
                    }

                    // update result metadata
                    state.resultMetaData[i] = {
                      ...searchRes.data,
                      hits: searchRes.data.hits[i],
                    };

                    // Update the metadata for the current query
                    Object.assign(
                      state.metadata.queries[i],
                      timeShiftQueries[i]?.metadata ?? {},
                    );
                  }

                  // get annotations
                  const annotationList = shouldFetchAnnotations()
                    ? await refreshAnnotations(
                        startISOTimestamp,
                        endISOTimestamp,
                      )
                    : [];
                  state.annotations = annotationList;

                  // need to break the loop, save the cache
                  // this is async task, which will be executed in background(await is not required)
                  saveCurrentStateToCache();
                } finally {
                  removeTraceId(traceId);
                }
              } catch (error) {
                // Process API error for "sql"
                processApiError(error, "sql");
                return { result: null, metadata: null };
              } finally {
                // set loading to false
                state.loading = false;
              }
            } else {
              const { query: query1, metadata: metadata1 } = replaceQueryValue(
                it.query,
                startISOTimestamp,
                endISOTimestamp,
                panelSchema.value.queryType,
              );

              const { query: query2, metadata: metadata2 } =
                await applyDynamicVariables(
                  query1,
                  panelSchema.value.queryType,
                );

              const query = query2;

              const metadata: any = {
                originalQuery: it.query,
                query: query,
                startTime: startISOTimestamp,
                endTime: endISOTimestamp,
                queryType: panelSchema.value.queryType,
                variables: [...(metadata1 || []), ...(metadata2 || [])],
                timeRangeGap: {
                  seconds: 0,
                  periodAsStr: "",
                },
              };

              state.metadata.queries[panelQueryIndex] = metadata;
              const annotations = shouldFetchAnnotations()
                ? await refreshAnnotations(
                    Number(startISOTimestamp),
                    Number(endISOTimestamp),
                  )
                : [];
              state.annotations = annotations;

              if (isStreamingEnabled(store.state)) {
                await getDataThroughStreaming(
                  query,
                  it,
                  startISOTimestamp,
                  endISOTimestamp,
                  pageType,
                  panelQueryIndex,
                  abortControllerRef,
                );
              } else if (isWebSocketEnabled(store.state)) {
                await getDataThroughWebSocket(
                  query,
                  it,
                  startISOTimestamp,
                  endISOTimestamp,
                  pageType,
                  panelQueryIndex,
                );
              } else {
                await getDataThroughPartitions(
                  query,
                  metadata,
                  it,
                  startISOTimestamp,
                  endISOTimestamp,
                  pageType,
                  abortControllerRef,
                );
              }

              // this is async task, which will be executed in background(await is not required)
              saveCurrentStateToCache();
            }
          }

          log("logaData: state.data", state.data);
          log("logaData: state.metadata", state.metadata);
        } finally {
          // abort on done
          if (abortControllerRef) {
            abortControllerRef?.abort();
          }
        }
      }
    } catch (error: any) {
      if (
        error.name === "AbortError" ||
        error.message === "Aborted waiting for loading"
      ) {
        log("logaData: Operation aborted");
      } else {
        log("logaData: An error occurred:", error);
      }
    }
  };

  watch(
    // Watching for changes in panelSchema, selectedTimeObj and forceLoad
    () => [panelSchema?.value, selectedTimeObj?.value, forceLoad?.value],
    async () => {
      log("PanelSchema/Time Wather: called");
      loadData(); // Loading the data
    },
  );

  /**
   * Replaces the query with the corresponding variable values.
   *
   * @param {any} query - The query to be modified.
   * @return {any} The modified query with replaced values.
   */
  const replaceQueryValue = (
    query: any,
    startISOTimestamp: any,
    endISOTimestamp: any,
    queryType: any,
  ) => {
    const metadata: any[] = [];

    //fixed variables value calculations
    //scrape interval by default 15 seconds
    const scrapeInterval =
      store.state.organizationData.organizationSettings.scrape_interval ?? 15;

    // timestamp in seconds / chart panel width
    const __interval =
      (endISOTimestamp - startISOTimestamp) /
      (chartPanelRef.value?.offsetWidth ?? 1000) /
      1000;

    // if less than 1, set it to 1
    // minimum will be 15000 millisecond
    // __interval = Math.max(15000, __interval);

    // round interval
    const formattedInterval = formatInterval(__interval);

    // calculate rate interval in seconds
    // we need formatted interval value in seconds
    const __rate_interval: any = Math.max(
      getTimeInSecondsBasedOnUnit(
        formattedInterval.value,
        formattedInterval.unit,
      ) + scrapeInterval,
      4 * scrapeInterval,
    );

    //get interval in ms
    const __interval_ms =
      getTimeInSecondsBasedOnUnit(
        formattedInterval.value,
        formattedInterval.unit,
      ) * 1000;

    const fixedVariables = [
      {
        name: "__interval_ms",
        value: `${__interval_ms}ms`,
      },
      {
        name: "__interval",
        value: `${formattedInterval.value}${formattedInterval.unit}`,
      },
      {
        name: "__rate_interval",
        value: `${formatRateInterval(__rate_interval)}`,
      },
    ];

    // replace fixed variables with its values
    fixedVariables?.forEach((variable: any) => {
      // replace $VARIABLE_NAME or ${VARIABLE_NAME} with its value
      const variableName = `$${variable.name}`;
      const variableNameWithBrackets = `\${${variable.name}}`;
      const variableValue = variable.value;
      if (
        query.includes(variableName) ||
        query.includes(variableNameWithBrackets)
      ) {
        metadata.push({
          type: "fixed",
          name: variable.name,
          value: variable.value,
        });
      }
      query = query.replaceAll(variableNameWithBrackets, variableValue);
      query = query.replaceAll(variableName, variableValue);
    });

    if (currentDependentVariablesData?.length) {
      currentDependentVariablesData?.forEach((variable: any) => {
        // replace $VARIABLE_NAME or ${VARIABLE_NAME} with its value
        const variableName = `$${variable.name}`;
        const variableNameWithBrackets = `\${${variable.name}}`;

        let variableValue = "";
        if (Array.isArray(variable.value)) {
          const value =
            variable.value
              .map(
                (value: any) =>
                  `'${variable.escapeSingleQuotes ? escapeSingleQuotes(value) : value}'`,
              )
              .join(",") || "''";
          const possibleVariablesPlaceHolderTypes = [
            {
              placeHolder: `\${${variable.name}:csv}`,
              value: variable.value.join(","),
            },
            {
              placeHolder: `\${${variable.name}:pipe}`,
              value: variable.value.join("|"),
            },
            {
              placeHolder: `\${${variable.name}:doublequote}`,
              value:
                variable.value.map((value: any) => `"${value}"`).join(",") ||
                '""',
            },
            {
              placeHolder: `\${${variable.name}:singlequote}`,
              value: value,
            },
            {
              placeHolder: `\${${variable.name}}`,
              value: queryType === "sql" ? value : variable.value.join("|"),
            },
            {
              placeHolder: `\$${variable.name}`,
              value: queryType === "sql" ? value : variable.value.join("|"),
            },
          ];

          possibleVariablesPlaceHolderTypes.forEach((placeHolderObj) => {
            if (query.includes(placeHolderObj.placeHolder)) {
              metadata.push({
                type: "variable",
                name: variable.name,
                value: placeHolderObj.value,
              });
            }
            query = query.replaceAll(
              placeHolderObj.placeHolder,
              placeHolderObj.value,
            );
          });
        } else {
          variableValue =
            variable.value === null
              ? ""
              : `${variable.escapeSingleQuotes ? escapeSingleQuotes(variable.value) : variable.value}`;
          if (
            query.includes(variableName) ||
            query.includes(variableNameWithBrackets)
          ) {
            metadata.push({
              type: "variable",
              name: variable.name,
              value: variable.value,
            });
          }
          query = query.replaceAll(variableNameWithBrackets, variableValue);
          query = query.replaceAll(variableName, variableValue);
        }
      });

      return { query, metadata };
    } else {
      return { query, metadata };
    }
  };

  const applyDynamicVariables = async (query: any, queryType: any) => {
    const metadata: any[] = [];
    const adHocVariables = variablesData.value?.values
      ?.filter((it: any) => it.type === "dynamic_filters")
      ?.map((it: any) => it?.value)
      .flat()
      ?.filter((it: any) => it?.operator && it?.name && it?.value);

    if (!adHocVariables?.length) {
      return { query, metadata };
    }

    // continue if there are any adhoc queries
    if (queryType === "promql") {
      adHocVariables.forEach((variable: any) => {
        metadata.push({
          type: "dynamicVariable",
          name: variable.name,
          value: variable.value,
          operator: variable.operator,
        });

        query = addLabelToPromQlQuery(
          query,
          variable.name,
          variable.value,
          variable.operator,
        );
      });
    }

    if (queryType === "sql") {
      const queryStream = await getStreamFromQuery(query);

      const applicableAdHocVariables = adHocVariables;
      // .filter((it: any) => {
      //   return it?.streams?.find((it: any) => it.name == queryStream);
      // });

      applicableAdHocVariables.forEach((variable: any) => {
        metadata.push({
          type: "dynamicVariable",
          name: variable.name,
          value: variable.value,
          operator: variable.operator,
        });
      });
      query = await addLabelsToSQlQuery(query, applicableAdHocVariables);
    }

    return { query, metadata };
  };

  /**
   * Processes an API error based on the given error and type.
   *
   * @param {any} error - The error object to be processed.
   * @param {any} type - The type of error being processed.
   */
  const processApiError = async (error: any, type: any) => {
    switch (type) {
      case "promql": {
        const errorDetailValue = error?.response?.data?.error || error?.message;
        const trimmedErrorMessage =
          errorDetailValue?.length > 300
            ? errorDetailValue.slice(0, 300) + " ..."
            : errorDetailValue;

        const errorCode =
          error?.response?.status ||
          error?.status ||
          error?.response?.data?.code ||
          "";

        state.errorDetail = {
          message: trimmedErrorMessage,
          code: errorCode,
        };
        break;
      }
      case "sql": {
        const errorDetailValue =
          error?.response?.data.error_detail ||
          error?.response?.data.message ||
          error?.message ||
          error?.error ||
          error?.error_detail;

        const trimmedErrorMessage =
          errorDetailValue?.length > 300
            ? errorDetailValue.slice(0, 300) + " ..."
            : errorDetailValue;

        const errorCode =
          isWebSocketEnabled(store.state) || isStreamingEnabled(store.state)
            ? error?.response?.data?.code || error?.code || error?.status || ""
            : error?.response?.status ||
              error?.status ||
              error?.response?.data?.code ||
              "";

        state.errorDetail = {
          message: trimmedErrorMessage,
          code: errorCode,
        };
        break;
      }
      default:
        break;
    }
  };

  const addTraceId = (traceId: string) => {
    if (state.searchRequestTraceIds.includes(traceId)) {
      return;
    }

    state.searchRequestTraceIds = [...state.searchRequestTraceIds, traceId];
  };

  const removeTraceId = (traceId: string) => {
    state.searchRequestTraceIds = state.searchRequestTraceIds.filter(
      (id: any) => id !== traceId,
    );
  };

  const hasAtLeastOneQuery = () =>
    panelSchema.value.queries?.some((q: any) => q?.query);

  // [START] variables management

  // check when the variables data changes
  // 1. get the dependent variables
  // 2. compare the dependent variables data with the old dependent variables Data
  // 3. if the value of any current variable is changed, call the api
  watch(
    () => variablesData?.value?.values,
    () => {
      // console.log("inside watch variablesData");
      // ensure the query is there
      // if (!panelSchema.value.queries?.length) {
      //   return;
      // }
      log("Variables Watcher: starting...");

      const newDependentVariablesData = getDependentVariablesData();
      const newDynamicVariablesData = getDynamicVariablesData();

      if (
        !newDependentVariablesData?.length &&
        !newDynamicVariablesData?.length &&
        !currentDependentVariablesData?.length &&
        !currentDynamicVariablesData?.length
      ) {
        // go ahead and bravly load the data
        log("Variables Watcher: no variables needed, returning false...");
        return;
      }

      if (variablesDataUpdated()) {
        loadData();
      }
    },
    { deep: true },
  );

  // [START] Variables functions
  const areDynamicVariablesStillLoading = () =>
    variablesData.value?.values?.some(
      (it: any) =>
        it.type === "dynamic_filters" &&
        (it.isLoading || it.isVariableLoadingPending),
    );

  const areDependentVariablesStillLoadingWith = (
    newDependentVariablesData: any,
  ) =>
    newDependentVariablesData?.some(
      (it: any) =>
        (it.value == null ||
          (Array.isArray(it.value) && it.value.length === 0)) &&
        (it.isLoading || it.isVariableLoadingPending),
    );

  const getDependentVariablesData = () =>
    variablesData.value?.values
      ?.filter((it: any) => it.type != "dynamic_filters") // ad hoc filters are not considered as dependent filters as they are globally applied
      ?.filter((it: any) => {
        const regexForVariable = new RegExp(
          `.*\\$\\{?${it.name}(?::(csv|pipe|doublequote|singlequote))?}?.*`,
        );

        return panelSchema.value.queries
          ?.map((q: any) => regexForVariable.test(q?.query))
          ?.includes(true);
      });

  const getDynamicVariablesData = () => {
    const sqlQueryStreams =
      panelSchema.value.queryType == "sql"
        ? panelSchema.value.queries.map((q: any) => getStreamFromQuery(q.query))
        : [];
    const adHocVariables = variablesData.value?.values
      ?.filter((it: any) => it.type === "dynamic_filters")
      ?.map((it: any) => it?.value)
      ?.flat()
      ?.filter((it: any) => it?.operator && it?.name && it?.value);
    // ?.filter((it: any) =>
    //   panelSchema.value.queryType == "sql"
    //     ? it.streams.find((it: any) => sqlQueryStreams.includes(it?.name))
    //     : true
    // );
    log("getDynamicVariablesData: adHocVariables", adHocVariables);
    return adHocVariables;
  };

  const updateCurrentDependentVariablesData = (
    newDependentVariablesData: any,
  ) => {
    currentDependentVariablesData = JSON.parse(
      JSON.stringify(newDependentVariablesData),
    );
  };

  const updateCurrentDynamicVariablesData = (newDynamicVariablesData: any) => {
    currentDynamicVariablesData = JSON.parse(
      JSON.stringify(newDynamicVariablesData),
    );
  };

  const areArraysEqual = (array1: any, array2: any) => {
    // Check if both arrays have the same length
    if (array1?.length !== array2?.length) {
      return false;
    }

    // Sort both arrays
    const sortedArray1 = array1?.slice()?.sort();
    const sortedArray2 = array2?.slice()?.sort();

    // Compare sorted arrays element by element
    for (let i = 0; i < sortedArray1?.length; i++) {
      if (sortedArray1[i] !== sortedArray2[i]) {
        return false;
      }
    }

    // If all elements are equal, return true
    return true;
  };

  const isAllRegularVariablesValuesSameWith = (
    newDependentVariablesData: any,
  ) =>
    newDependentVariablesData.every((it: any) => {
      const oldValue = currentDependentVariablesData.find(
        (it2: any) => it2.name == it.name,
      );
      // return it.value == oldValue?.value && oldValue?.value != "";
      return it.multiSelect
        ? areArraysEqual(it.value, oldValue?.value)
        : it.value == oldValue?.value && oldValue?.value != "";
    });

  const isAllDynamicVariablesValuesSameWith = (newDynamicVariablesData: any) =>
    newDynamicVariablesData.every((it: any) => {
      const oldValue = currentDynamicVariablesData?.find(
        (it2: any) => it2.name == it.name,
      );
      return (
        oldValue?.value != "" &&
        it.value == oldValue?.value &&
        it.operator == oldValue?.operator
      );
    });

  const ifPanelVariablesCompletedLoading = () => {
    // STEP 1: Check if there are any dynamic variables that are still loading
    log("Step1: checking if dynamic variables are loading, starting...");
    const newDynamicVariablesData = getDynamicVariablesData();

    if (areDynamicVariablesStillLoading()) {
      log("Step1: dynamic variables still loading..., returning false");
      return false;
    }

    // STEP 2: Check if any regular dependent variables are still loading

    log("Step2: checking if dependent variables are loading, starting...");

    const newDependentVariablesData = getDependentVariablesData();

    if (areDependentVariablesStillLoadingWith(newDependentVariablesData)) {
      log("Step2: regular variables still loading..., returning false");
      return false;
    }

    return true;
  };

  const variablesDataUpdated = () => {
    // STEP 1: Check if there are any dynamic variables that are still loading
    log("Step1: checking if dynamic variables are loading, starting...");
    const newDynamicVariablesData = getDynamicVariablesData();

    if (areDynamicVariablesStillLoading()) {
      log("Step1: dynamic variables still loading..., returning false");
      return false;
    }

    // STEP 2: Check if any regular dependent variables are still loading

    log("Step2: checking if dependent variables are loading, starting...");

    const newDependentVariablesData = getDependentVariablesData();

    if (areDependentVariablesStillLoadingWith(newDependentVariablesData)) {
      log("Step2: regular variables still loading..., returning false");
      return false;
    }

    // STEP 3: Check if any of the regular and dynamic variables count have changed
    // if count have changed, that means the variables are added or removed
    // so we need to fire the query
    log("Step3: checking if no of variables have changed, starting...");

    log(
      "Step3: newDependentVariablesData,",
      JSON.stringify(newDependentVariablesData, null, 2),
    );
    log(
      "Step3: newDynamicVariablesData...",
      JSON.stringify(newDynamicVariablesData, null, 2),
    );

    // if the length of the any of the regular and old dynamic data has changed,
    // we need to fire the query
    log(
      "Step3: newDependentVariablesData?.length",
      newDependentVariablesData?.length,
    );
    log(
      "Step3: newDynamicVariablesData?.length",
      newDynamicVariablesData?.length,
    );
    log(
      "Step3: currentDependentVariablesData?.length",
      currentDependentVariablesData?.length,
    );
    log(
      "Step3: currentAdHocVariablesData?.length",
      currentDynamicVariablesData?.length,
    );

    if (
      newDependentVariablesData?.length !=
        currentDependentVariablesData?.length ||
      newDynamicVariablesData?.length != currentDynamicVariablesData?.length
    ) {
      updateCurrentDependentVariablesData(newDependentVariablesData);
      updateCurrentDynamicVariablesData(newDynamicVariablesData);

      log(
        "Step3: length of the any of the regular and old dynamic data has changed, we need to fire the query",
      );
      return true;
    }

    log("Step3: finished...");
    // STEP 4: Now we know same number of variables are there and have updated,
    // we have to perform different action based on different combinations of variables types
    // 1. regular variables
    // 2. dynamic variables
    log("Step4: starting...");

    // now we have to check for different combinations for the count of regular and dynamic variables
    // 1. Regular variables  = 0 and Dynamic variables  = 0
    // 2. Regular variables >= 1 and Dynamic variables  = 0
    // 3. Regular variables  = 0 and Dynamic variables >= 1
    // 4. Regular variables >= 1 and Dynamic variables >= 1

    log(
      "Step4: newDependentVariablesData.length",
      newDependentVariablesData?.length,
    );
    log(
      "Step4: newDynamicVariablesData.length",
      newDynamicVariablesData?.length,
    );

    // execute different scenarios based on the count of variables
    if (
      !newDependentVariablesData?.length &&
      !newDynamicVariablesData?.length
    ) {
      // 1. Regular variables  = 0 and Dynamic variables  = 0
      // go ahead and bravly load the data
      !newDependentVariablesData?.length && !newDynamicVariablesData?.length;

      log(
        "Step4: 1: no variables are there, no waiting, can call the api, returning true...",
      );

      return true;
    } else if (
      newDependentVariablesData?.length &&
      !newDynamicVariablesData?.length
    ) {
      log("Step4: 2: Regular variables >= 1 and Dynamic variables  = 0");
      // 2. Regular variables >= 1 and Dynamic variables  = 0

      // log(
      //   "Step4: 2: checking against old values, currentDependentVariablesData",
      //   JSON.stringify(currentDependentVariablesData, null, 2)
      // );

      // check if the values have changed or not
      const isAllRegularVariablesValuesSame =
        isAllRegularVariablesValuesSameWith(newDependentVariablesData);

      if (isAllRegularVariablesValuesSame) {
        log("Step4: 2: regular variables has same old value, returning false");
        return false;
      }

      updateCurrentDependentVariablesData(newDependentVariablesData);

      log("Step4: 2: regular variables values has changed, returning true");
      return true;
    } else if (
      !newDependentVariablesData?.length &&
      newDynamicVariablesData?.length
    ) {
      // 3. Regular variables  = 0 and Dynamic variables >= 1
      log("Step4: 3: Regular variables  = 0 and Dynamic variables >= 1");

      // check if dynamic variables are same or changed
      const isAllDynamicVariablesValuesSame =
        isAllDynamicVariablesValuesSameWith(newDynamicVariablesData);

      // check if values are changed or not
      if (isAllDynamicVariablesValuesSame) {
        log("Step4: 3: dynamic variables has same old value, returning false");
        return false;
      }

      updateCurrentDynamicVariablesData(newDynamicVariablesData);

      log("Step4: 3: dynamic variables values has changed, returning true");
      return true;
    } else if (
      newDependentVariablesData?.length &&
      newDynamicVariablesData?.length
    ) {
      // 4. Regular variables >= 1 and Dynamic variables >= 1
      log("Step4: 4: Regular variables >= 1 and Dynamic variables >= 1");

      // if any of the value has changed, we need to trigger the query
      // check if the values have changed or not
      const isAllRegularVariablesValuesSame =
        isAllRegularVariablesValuesSameWith(newDependentVariablesData);

      const isAllDynamicVariablesValuesSame =
        isAllDynamicVariablesValuesSameWith(newDynamicVariablesData);

      log(
        "Step4: 4: isAllRegularVariablesValuesSame",
        isAllRegularVariablesValuesSame,
      );
      log(
        "Step4: 4: isAllDynamicVariablesValuesSame",
        isAllDynamicVariablesValuesSame,
      );

      // if any has changed
      if (isAllRegularVariablesValuesSame && isAllDynamicVariablesValuesSame) {
        log(
          "Step4: 4: regular and dynamic variables has same old value, returning false",
        );
        return false;
      }

      // values have changed
      // let's update and fire the query
      updateCurrentDynamicVariablesData(newDynamicVariablesData);
      updateCurrentDependentVariablesData(newDependentVariablesData);

      log("Step4: 4: variables values has changed, returning true");
      return true;
    }
  };

  const handleIntersection = async (entries: any) => {
    isVisible.value = entries[0].isIntersecting;
  };

  onMounted(async () => {
    observer = new IntersectionObserver(handleIntersection, {
      root: null,
      rootMargin: "0px",
      threshold: 0, // Adjust as needed
    });

    if (chartPanelRef?.value) observer.observe(chartPanelRef?.value);
  });

  // remove intersection observer
  onUnmounted(() => {
    // abort on unmount
    if (abortController) {
      // Only set isPartialData if we're still loading or haven't received complete response
      // AND we haven't already marked it as complete
      if (
        (state.loading || state.loadingProgressPercentage < 100) &&
        !state.isOperationCancelled
      ) {
        state.isPartialData = true;
      }
      abortController.abort();
    }
    if (observer) {
      observer.disconnect();
    }
    // cancel http2 queries using http streaming api
    if (
      isStreamingEnabled(store.state) &&
      state.searchRequestTraceIds?.length > 0
    ) {
      try {
        // Only set isPartialData if we're still loading or haven't received complete response
        // AND we haven't already marked it as complete
        if (
          (state.loading || state.loadingProgressPercentage < 100) &&
          !state.isOperationCancelled
        ) {
          state.isPartialData = true;
        }
        state.searchRequestTraceIds.forEach((traceId) => {
          cancelStreamQueryBasedOnRequestId({
            trace_id: traceId,
            org_id: store?.state?.selectedOrganization?.identifier,
          });
        });
      } catch (error) {
        console.error("Error during HTTP2 cleanup:", error);
      } finally {
        state.searchRequestTraceIds = [];
      }
    }

    // Cancel WebSocket queries
    if (
      isWebSocketEnabled(store.state) &&
      state.searchRequestTraceIds?.length > 0
    ) {
      try {
        // Only set isPartialData if we're still loading or haven't received complete response
        // AND we haven't already marked it as complete
        if (
          (state.loading || state.loadingProgressPercentage < 100) &&
          !state.isOperationCancelled
        ) {
          state.isPartialData = true;
        }
        state.searchRequestTraceIds.forEach((traceId) => {
          cancelSearchQueryBasedOnRequestId({
            trace_id: traceId,
            org_id: store?.state?.selectedOrganization?.identifier,
          });
        });
      } catch (error) {
        console.error("Error during WebSocket cleanup:", error);
      } finally {
        state.searchRequestTraceIds = [];
      }
    }

    // remove cancelquery event
    window.removeEventListener("cancelQuery", cancelQueryAbort);
  });

  onMounted(async () => {
    log("PanelSchema/Time Initial: should load the data");

    loadData(); // Loading the data
  });

  const restoreFromCache: () => Promise<boolean> = async () => {
    const cache = await getPanelCache();

    if (!cache) {
      log("usePanelDataLoader: panelcache: cache is not there");
      // cache is not there, we need to load the data
      return false;
    }
    // now we have a cache
    const { key: tempPanelCacheKey, value: tempPanelCacheValue } = cache;
    log("usePanelDataLoader: panelcache: tempPanelCache", tempPanelCacheValue);

    let isRestoredFromCache = false;

    const keysToIgnore = [
      "panelSchema.version",
      "panelSchema.layout",
      "panelSchema.htmlContent",
      "panelSchema.markdownContent",
    ];

    log("usePanelDataLoader: panelcache: tempPanelCacheKey", tempPanelCacheKey);
    log(
      "usePanelDataLoader: panelcache: omit(getCacheKey())",
      omit(getCacheKey(), keysToIgnore),
    );
    log(
      "usePanelDataLoader: panelcache: omit(tempPanelCacheKey))",
      omit(tempPanelCacheKey, keysToIgnore),
    );

    // check if it is stale or not
    if (
      tempPanelCacheValue &&
      Object.keys(tempPanelCacheValue).length > 0 &&
      isEqual(
        omit(getCacheKey(), keysToIgnore),
        omit(tempPanelCacheKey, keysToIgnore),
      )
    ) {
      // const cache = getPanelCache();
      state.data = tempPanelCacheValue.data;
      state.loading = tempPanelCacheValue.loading;
      state.errorDetail = tempPanelCacheValue.errorDetail;
      state.metadata = tempPanelCacheValue.metadata;
      state.resultMetaData = tempPanelCacheValue.resultMetaData;
      state.annotations = tempPanelCacheValue.annotations;
      state.lastTriggeredAt = tempPanelCacheValue.lastTriggeredAt;
      // Restore isPartialData and isOperationCancelled from cache
      state.isPartialData = tempPanelCacheValue.isPartialData;
      state.isOperationCancelled = tempPanelCacheValue.isOperationCancelled;

      // set that the cache is restored
      isRestoredFromCache = true;

      // if selected time range is not matched with the cache time range
      if (
        selectedTimeObj?.value?.end_time -
          selectedTimeObj?.value?.start_time !==
        cache?.cacheTimeRange?.end_time - cache?.cacheTimeRange?.start_time
      ) {
        state.isCachedDataDifferWithCurrentTimeRange = true;
      }

      log("usePanelDataLoader: panelcache: panel data loaded from cache");
    }

    return isRestoredFromCache;
  };

  return {
    ...toRefs(state),
    loadData,
  };
};
