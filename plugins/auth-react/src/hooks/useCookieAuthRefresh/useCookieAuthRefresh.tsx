/*
 * Copyright 2024 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useCallback, useMemo } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  storageApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { useAsync, useMountEffect } from '@react-hookz/web';
import { ResponseError } from '@backstage/errors';

/**
 * @public
 * A hook that will refresh the cookie when it is about to expire.
 * @param options - Options for configuring the refresh cookie endpoint
 */
export function useCookieAuthRefresh(options: {
  // The plugin id to used for discovering the API origin
  pluginId: string;
  // The path to used for calling the refresh cookie endpoint, default to '/cookie'
  path?: string;
}): {
  status: 'loading' | 'error' | 'success';
  error?: Error;
  result?: {
    expiresAt: string;
  };
  retry: () => void;
} {
  const { pluginId, path = '/cookie' } = options ?? {};
  const fetchApi = useApi(fetchApiRef);
  const storageApi = useApi(storageApiRef);
  const discoveryApi = useApi(discoveryApiRef);

  const store = storageApi.forBucket(`${pluginId}-auth-cookie-storage`);

  const [state, actions] = useAsync<{ expiresAt: string }>(async () => {
    const apiOrigin = await discoveryApi.getBaseUrl(pluginId);
    const requestUrl = `${apiOrigin}${path}`;
    const response = await fetchApi.fetch(`${requestUrl}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
    return await response.json();
  });

  useMountEffect(actions.execute);

  const refresh = useCallback(
    (params: { expiresAt: string }) => {
      // Randomize the refreshing margin to avoid all tabs refreshing at the same time
      const margin = (1 + 3 * Math.random()) * 60000;
      const delay = Date.parse(params.expiresAt) - Date.now() - margin;
      const timeout = setTimeout(actions.execute, delay);
      return () => clearTimeout(timeout);
    },
    [actions],
  );

  useEffect(() => {
    // Only start the refresh process if we have a successful response
    if (state.status !== 'success' || !state.result) {
      return () => {};
    }

    store.set('expiresAt', state.result.expiresAt);

    let cancel = refresh(state.result);

    const observable = store.observe$<string>('expiresAt');
    const subscription = observable.subscribe(({ value }) => {
      if (!value) return;
      cancel();
      cancel = refresh({ expiresAt: value });
    });

    return () => {
      cancel();
      subscription.unsubscribe();
    };
  }, [state, refresh, store]);

  const status = useMemo(() => {
    // Initialising
    if (state.status === 'not-executed') {
      return 'loading';
    }

    // First refresh or retrying without any success before
    // Possible states transitions:
    // e.g. not-executed -> loading (first-refresh)
    // e.g. not-executed -> loading (first-refresh) -> error -> loading (manual-retry)
    if (state.status === 'loading' && !state.result) {
      return 'loading';
    }

    // Retrying after having succeeding at least once
    // Current states is: { status: 'loading', result: {...}, error: undefined | Error }
    // e.g. not-executed -> loading (first-refresh) -> success -> loading (scheduled-refresh) -> error -> loading (manual-retry)
    if (state.status === 'loading' && state.error) {
      return 'loading';
    }

    // Something went wrong during the any situation of a refresh
    if (state.status === 'error' && state.error) {
      return 'error';
    }

    return 'success';
  }, [state]);

  const retry = useCallback(() => {
    actions.execute();
  }, [actions]);

  return {
    retry,
    status,
    result: state.result,
    error: state.error,
  };
}
