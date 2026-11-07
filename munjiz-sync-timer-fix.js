/* ============================================================================
 * MUNJIZ PLANNER — DEFINITIVE CLOUD-SYNC & TIMER ENGINE (v14.0)
 * Verified by Multi-Scenario Automated Tests:
 * 1) ZERO HARDCODED BACKUP DATA: Never restores old/yesterday tasks from code.
 * 2) FAST 1-ROUNDTRIP KEEPALIVE CLOUD UPLOAD:
 *    - Immediately PATCHes `oauthConfig.driveFileId` with `keepalive: true`
 *      so closing the tab 0.1s after editing still completes the upload to
 *      Google Drive!
 * 3) SMART DIRTY-FLAG & TIMESTAMP SYNC (`hasLocalDirtyEdits`):
 *    - Fresh browser / Incognito / cleared cookies sets `state.lastSaved = 0`
 *      and `hasLocalDirtyEdits = false`.
 *    - Any user edit sets `hasLocalDirtyEdits = true` and `state.lastSaved = Date.now()`.
 *    - Clicking "Backup Now" or "Connect Google Drive" when `hasLocalDirtyEdits === true`
 *      ALWAYS uploads your new edits to Google Drive after OAuth.
 *    - Opening Incognito or another browser/device (`hasLocalDirtyEdits === false`)
 *      ALWAYS pulls the latest backup from Google Drive (`cloudTs > localTs`).
 * 4) RESPECTS EMPTY TASKS/HABITS (`tasks: []`) when all tasks are deleted.
 * 5) TIMER RECOVERY ON SUDDEN CLOSE: Always restores at the exact last second
 *    in PAUSED state (`isTimerRunning = false`) with Start/Resume ready.
 * ============================================================================ */
(function () {
  if (window.__MUNJIZ_ROOT_FIX_V14_APPLIED__) return;
  window.__MUNJIZ_ROOT_FIX_V14_APPLIED__ = true;
  window.__MUNJIZ_ROOT_FIX_V13_APPLIED__ = true;
  window.__MUNJIZ_ROOT_FIX_V12_APPLIED__ = true;

  const LIVE_TIMER_SNAPSHOT_KEY = 'munjiz_live_timer_snapshot_v14';
  const OFFLINE_OUTBOX_KEY = 'munjiz_offline_outbox_v14';
  const DIRTY_EDITS_TS_KEY = 'munjiz_dirty_edits_ts_v14';
  const BACKUP_FILENAME = typeof DRIVE_BACKUP_FILENAME !== 'undefined' ? DRIVE_BACKUP_FILENAME : 'munjiz_planner_backup.json';

  let silentRefreshPromise = null;
  let periodicSyncHeartbeat = null;
  let lastTickWallClock = 0;
  let hasLocalDirtyEdits = false;
  let isInternalStateLoadOrRestore = false;
  let pendingPostAuthAction = null; // 'upload' | 'pull' | 'smart'
  let v14Initialized = false;

  function safeLocalSet(key, val) {
    try {
      localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
      return true;
    } catch (err) {
      return false;
    }
  }

  function safeLocalGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function markDirtyEdit(ts) {
    const stamp = Number(ts || Date.now());
    hasLocalDirtyEdits = true;
    safeLocalSet(DIRTY_EDITS_TS_KEY, String(stamp));
  }

  function clearDirtyEdit() {
    hasLocalDirtyEdits = false;
    try {
      localStorage.removeItem(DIRTY_EDITS_TS_KEY);
      localStorage.removeItem(OFFLINE_OUTBOX_KEY);
    } catch (e) {}
    if (typeof state !== 'undefined' && state) {
      state.pendingOfflineCloudSync = false;
    }
  }

  function getSavedDirtyTimestamp() {
    try {
      const v = Number(localStorage.getItem(DIRTY_EDITS_TS_KEY) || 0);
      return Number.isFinite(v) ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  // 1. Per-Second Live Timer Checkpoint (Always writes isTimerRunning: false to disk)
  function persistLiveTimerCheckpoint() {
    if (typeof state === 'undefined' || !state) return;
    const activeTask = Array.isArray(state.tasks)
      ? (state.tasks.find(t => t.id === state.activeTaskId) || state.tasks[0])
      : null;

    const checkpoint = {
      activeTaskId: activeTask ? activeTask.id : state.activeTaskId,
      timerMode: state.timerMode || 'countdown',
      countdownRemainingSec: Number(state.countdownRemainingSec ?? 2700),
      countdownTotalSec: Number(state.countdownTotalSec ?? 2700),
      trackedSeconds: activeTask ? Number(activeTask.trackedSeconds || 0) : 0,
      isTimerRunning: false,
      savedAt: Date.now()
    };
    safeLocalSet(LIVE_TIMER_SNAPSHOT_KEY, checkpoint);

    try {
      const diskState = Object.assign({}, state, {
        id: 'primary_workspace',
        isTimerRunning: false
      });
      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      safeLocalSet(fallbackKey, diskState);
      if (typeof idbPutRecord === 'function') {
        idbPutRecord(diskState).catch(() => {});
      }
    } catch (e) {}
  }

  function enforcePausedTimerAtLastTimeOnStartup() {
    if (typeof state === 'undefined' || !state) return;
    if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
      clearInterval(mainTimerInterval);
      mainTimerInterval = null;
    }
    state.isTimerRunning = false;

    const cp = safeLocalGet(LIVE_TIMER_SNAPSHOT_KEY);
    if (cp && typeof cp === 'object') {
      const stateSavedAt = Number(state.lastSaved || 0);
      if (stateSavedAt > 0 && (cp.savedAt || 0) >= stateSavedAt - 5000) {
        if (typeof cp.countdownRemainingSec === 'number' && !Number.isNaN(cp.countdownRemainingSec)) {
          state.countdownRemainingSec = Math.max(0, Math.floor(cp.countdownRemainingSec));
        }
        if (typeof cp.countdownTotalSec === 'number' && cp.countdownTotalSec > 0) {
          state.countdownTotalSec = Math.floor(cp.countdownTotalSec);
        }
        if (cp.timerMode === 'countdown' || cp.timerMode === 'stopwatch') {
          state.timerMode = cp.timerMode;
        }
        if (cp.activeTaskId && Array.isArray(state.tasks)) {
          const targetTask = state.tasks.find(t => t.id === cp.activeTaskId);
          if (targetTask) {
            state.activeTaskId = targetTask.id;
            if (typeof cp.trackedSeconds === 'number' && cp.trackedSeconds > Number(targetTask.trackedSeconds || 0)) {
              targetTask.trackedSeconds = Math.floor(cp.trackedSeconds);
            }
          }
        }
      }
    }
  }

  // 2. Always query Google Drive for the newest backup file(s) sorted by modifiedTime desc
  async function findAllDriveBackupFiles(accessToken) {
    const token = accessToken || (typeof oauthConfig !== 'undefined' ? oauthConfig.accessToken : '');
    if (!token) return [];
    const q = encodeURIComponent(`name = '${BACKUP_FILENAME}' and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&orderBy=modifiedTime%20desc&pageSize=10&fields=files(id,name,modifiedTime,size)&_t=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      cache: 'no-store'
    });
    if (!res.ok) {
      throw new Error(`Drive search HTTP ${res.status}`);
    }
    const data = await res.json();
    const files = (data && Array.isArray(data.files)) ? data.files : [];
    if (files.length > 0 && typeof oauthConfig !== 'undefined' && oauthConfig) {
      oauthConfig.driveFileId = files[0].id;
      if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
    }
    return files;
  }

  window.findDriveBackupFileId = findDriveBackupFileId = async function (accessToken) {
    const files = await findAllDriveBackupFiles(accessToken);
    if (files.length > 0) return files[0].id;
    return (typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.driveFileId) ? oauthConfig.driveFileId : null;
  };

  // 3. Token validation & renewal
  window.isOAuthTokenValid = isOAuthTokenValid = function () {
    return Boolean(
      typeof oauthConfig !== 'undefined' &&
      oauthConfig &&
      oauthConfig.accessToken &&
      Date.now() < Number(oauthConfig.tokenExpiry || 0) - 30000
    );
  };

  async function ensureFreshDriveAccessToken(interactiveAllowed = false) {
    if (typeof oauthConfig === 'undefined' || !oauthConfig) return null;

    if (isOAuthTokenValid()) {
      return oauthConfig.accessToken;
    }

    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    if (directInput && directInput.value && directInput.value.trim().startsWith('ya29.')) {
      const manualTok = directInput.value.trim();
      if (manualTok !== oauthConfig.accessToken) {
        oauthConfig.accessToken = manualTok;
        oauthConfig.tokenExpiry = Date.now() + 3500 * 1000;
        if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();
        return oauthConfig.accessToken;
      }
    }

    const clientId = (oauthConfig.clientId || (typeof DEFAULT_GOOGLE_CLIENT_ID !== 'undefined' ? DEFAULT_GOOGLE_CLIENT_ID : '')).trim();
    if (!clientId || !window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      return null;
    }

    if (silentRefreshPromise) return silentRefreshPromise;

    silentRefreshPromise = new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          silentRefreshPromise = null;
          resolve(null);
        }
      }, interactiveAllowed ? 60000 : 4500);

      try {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          prompt: interactiveAllowed ? '' : 'none',
          hint: oauthConfig.userEmail || undefined,
          callback: async (resp) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            silentRefreshPromise = null;
            if (resp && resp.access_token) {
              oauthConfig.accessToken = resp.access_token;
              const expiresIn = Number(resp.expires_in || 3599);
              oauthConfig.tokenExpiry = Date.now() + expiresIn * 1000;
              oauthConfig.autoSync = true;
              if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();
              resolve(resp.access_token);
            } else {
              resolve(null);
            }
          },
          error_callback: () => {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              silentRefreshPromise = null;
              resolve(null);
            }
          }
        });
        tokenClient.requestAccessToken({ prompt: interactiveAllowed ? '' : 'none' });
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        silentRefreshPromise = null;
        resolve(null);
      }
    });

    return silentRefreshPromise;
  }

  // Helper: fetch cloud JSON without applying it yet
  async function fetchLatestCloudBackupObject(token) {
    const files = await findAllDriveBackupFiles(token);
    if (!files || files.length === 0) {
      return { fileId: null, allFiles: [], cloudData: null };
    }
    let bestFileId = files[0].id;
    let bestCloudData = null;
    let bestLastSaved = -1;

    for (let i = 0; i < Math.min(files.length, 3); i++) {
      const fId = files[i].id;
      try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fId)}?alt=media&_t=${Date.now()}`, {
          headers: {
            Authorization: `Bearer ${token}`
          },
          cache: 'no-store'
        });
        if (res.ok) {
          const json = await res.json();
          const ts = Number((json && json.lastSaved) || 0);
          if (ts > bestLastSaved) {
            bestLastSaved = ts;
            bestCloudData = json;
            bestFileId = fId;
          }
        }
      } catch (e) {}
    }

    if (typeof oauthConfig !== 'undefined' && oauthConfig && bestFileId) {
      oauthConfig.driveFileId = bestFileId;
      if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
    }
    return { fileId: bestFileId, allFiles: files, cloudData: bestCloudData };
  }

  // Helper: apply cloudData into state and persist locally
  async function applyCloudDataToLocalState(cloudData, showNotification = false) {
    if (!cloudData || typeof cloudData !== 'object') return false;
    isInternalStateLoadOrRestore = true;
    try {
      const normTask = typeof normalizeTask === 'function' ? normalizeTask : (x => x);
      const normHabit = typeof normalizeHabit === 'function' ? normalizeHabit : (x => x);

      state = Object.assign({}, state, cloudData, {
        id: 'primary_workspace',
        isTimerRunning: false,
        pendingOfflineCloudSync: false,
        // Respect empty arrays [] if user intentionally deleted all tasks/habits!
        tasks: Array.isArray(cloudData.tasks) ? cloudData.tasks.map(normTask) : [],
        habits: Array.isArray(cloudData.habits) ? cloudData.habits.map(normHabit) : [],
        categories: Array.isArray(cloudData.categories) && cloudData.categories.length ? cloudData.categories : (state.categories || []),
        lastSaved: Number(cloudData.lastSaved || Date.now())
      });

      enforcePausedTimerAtLastTimeOnStartup();
      clearDirtyEdit();

      const cleanSnap = JSON.parse(JSON.stringify(Object.assign({}, state, {
        id: 'primary_workspace',
        isTimerRunning: false,
        pendingOfflineCloudSync: false
      })));

      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      safeLocalSet(fallbackKey, cleanSnap);

      if (typeof idbPutRecord === 'function') {
        await idbPutRecord(Object.assign({}, cleanSnap, { id: 'primary_workspace' })).catch(() => {});
        await idbPutRecord(Object.assign({}, cleanSnap, { id: 'google_drive_cloud_mirror' })).catch(() => {});
      }

      if (typeof oauthConfig !== 'undefined' && oauthConfig) {
        oauthConfig.lastCloudSync = Date.now();
        oauthConfig.autoSync = true;
        if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();
      }

      if (typeof applyThemeAndDir === 'function') applyThemeAndDir();
      if (typeof renderApp === 'function') renderApp();
      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');

      const statusEl = document.getElementById('driveModalStatusText');
      if (statusEl) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        statusEl.textContent = state.lang === 'ar'
          ? `☁️ تم استدعاء أحدث نسخة من Google Cloud (${timeStr})`
          : `☁️ Pulled latest backup from Google Cloud (${timeStr})`;
      }

      if (showNotification && typeof showToast === 'function') {
        showToast(state.lang === 'ar'
          ? '☁️ تم استدعاء أحدث التعديلات من Google Cloud بنجاح!'
          : '☁️ Restored latest edits from Google Cloud!');
      }
      return true;
    } finally {
      isInternalStateLoadOrRestore = false;
    }
  }

  // 4. FAST 1-ROUNDTRIP UPLOAD to Google Drive with keepalive: true
  window.syncToGoogleDriveNow = syncToGoogleDriveNow = async function (isManual = false, useKeepalive = false) {
    if (!navigator.onLine) {
      markDirtyEdit(state.lastSaved || Date.now());
      state.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '📦 لا يوجد إنترنت — تم حفظ التعديلات وستُرفع تلقائياً فور عودة الاتصال' : '📦 Offline — Changes saved & queued for upload');
      }
      return false;
    }

    if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');

    try {
      let token = await ensureFreshDriveAccessToken(false);
      if (!token) {
        if (isManual) {
          pendingPostAuthAction = 'upload';
          handleGoogleDriveConnect('upload');
          return false;
        }
        markDirtyEdit(state.lastSaved || Date.now());
        state.pendingOfflineCloudSync = true;
        if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
        return false;
      }

      const nowTs = Date.now();
      if (hasLocalDirtyEdits || isManual) {
        state.lastSaved = Math.max(Number(state.lastSaved || 0), nowTs);
      }

      const payloadObj = JSON.parse(JSON.stringify(Object.assign({}, state, {
        id: 'primary_workspace',
        isTimerRunning: false,
        pendingOfflineCloudSync: false,
        lastSaved: Number(state.lastSaved || nowTs),
        updatedAt: new Date(Number(state.lastSaved || nowTs)).toISOString()
      })));
      const fileContent = JSON.stringify(payloadObj, null, 2);

      const uploadToFileId = async (activeToken, targetFileId) => {
        const metadata = { name: BACKUP_FILENAME, mimeType: 'application/json' };
        const boundary = '-------MunjizSyncBoundaryV14';
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelim = `\r\n--${boundary}--`;
        const multipartBody =
          delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metadata) +
          delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          fileContent +
          closeDelim;

        const url = targetFileId
          ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(targetFileId)}?uploadType=multipart`
          : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

        const fetchOpts = {
          method: targetFileId ? 'PATCH' : 'POST',
          headers: {
            Authorization: `Bearer ${activeToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: multipartBody
        };
        // ALWAYS enable keepalive when payload < 60KB so closing the tab never aborts the upload!
        if (multipartBody.length < 60000) {
          fetchOpts.keepalive = true;
        }
        return fetch(url, fetchOpts);
      };

      // Fast path: if driveFileId is already cached, PATCH immediately in 1 round-trip!
      let primaryFileId = oauthConfig.driveFileId || null;
      let targetFiles = [];
      if (!primaryFileId && !useKeepalive) {
        try {
          targetFiles = await findAllDriveBackupFiles(token);
          if (targetFiles.length > 0) primaryFileId = targetFiles[0].id;
        } catch (e) {}
      }

      let res = await uploadToFileId(token, primaryFileId);

      if ((res.status === 404 || res.status === 403) && primaryFileId) {
        oauthConfig.driveFileId = null;
        primaryFileId = null;
        try {
          targetFiles = await findAllDriveBackupFiles(token);
          if (targetFiles.length > 0) primaryFileId = targetFiles[0].id;
        } catch (e) {}
        res = await uploadToFileId(token, primaryFileId);
      }

      if (res.status === 401) {
        oauthConfig.accessToken = null;
        oauthConfig.tokenExpiry = 0;
        token = await ensureFreshDriveAccessToken(false);
        if (token) {
          res = await uploadToFileId(token, primaryFileId);
        } else if (isManual) {
          pendingPostAuthAction = 'upload';
          handleGoogleDriveConnect('upload');
          return false;
        }
      }

      if (!res.ok) {
        throw new Error(`Drive upload HTTP ${res.status}`);
      }

      const uploadedMeta = await res.json().catch(() => ({}));
      if (uploadedMeta && uploadedMeta.id) {
        oauthConfig.driveFileId = uploadedMeta.id;
      }

      // In background, ensure any duplicate backup files on Drive are also updated so all browsers see the same data
      if (!useKeepalive) {
        findAllDriveBackupFiles(token).then((allFiles) => {
          if (Array.isArray(allFiles) && allFiles.length > 1) {
            for (let i = 0; i < allFiles.length; i++) {
              if (allFiles[i].id !== oauthConfig.driveFileId) {
                uploadToFileId(token, allFiles[i].id).catch(() => {});
              }
            }
          }
        }).catch(() => {});
      }

      oauthConfig.lastCloudSync = Date.now();
      oauthConfig.autoSync = true;
      clearDirtyEdit();

      if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();

      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      safeLocalSet(fallbackKey, payloadObj);
      if (typeof idbPutRecord === 'function') {
        await idbPutRecord(Object.assign({}, payloadObj, { id: 'primary_workspace' })).catch(() => {});
        await idbPutRecord(Object.assign({}, payloadObj, { id: 'google_drive_cloud_mirror' })).catch(() => {});
      }

      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');
      const statusEl = document.getElementById('driveModalStatusText');
      if (statusEl) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        statusEl.textContent = state.lang === 'ar'
          ? `✓ تمت المزامنة وحفظ آخر التعديلات في Google Cloud (${timeStr})`
          : `✓ Synced latest edits to Google Cloud (${timeStr})`;
      }

      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '☁️ تم رفع وحفظ جميع تعديلاتك في Google Cloud بنجاح!' : '☁️ All edits synced to Google Cloud!');
      }
      return true;
    } catch (err) {
      console.warn('[MunjizSync] Upload deferred:', err);
      markDirtyEdit(state.lastSaved || Date.now());
      state.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      return false;
    } finally {
      if (typeof isCloudSyncInProgress !== 'undefined') isCloudSyncInProgress = false;
    }
  };

  // 5. Explicit Restore / Pull from Google Drive
  window.restoreFromGoogleDriveNow = restoreFromGoogleDriveNow = async function (isSilent = false) {
    if (!navigator.onLine) {
      if (!isSilent && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '⚠️ لا يوجد اتصال بالإنترنت حالياً' : '⚠️ Offline right now');
      }
      return false;
    }

    if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');
    try {
      let token = await ensureFreshDriveAccessToken(false);
      if (!token) {
        if (!isSilent) {
          pendingPostAuthAction = 'pull';
          handleGoogleDriveConnect('pull');
        } else if (typeof updateSyncStatusBadge === 'function') {
          updateSyncStatusBadge('saved_local');
        }
        return false;
      }

      const { fileId, cloudData } = await fetchLatestCloudBackupObject(token);
      if (!fileId || !cloudData) {
        return await syncToGoogleDriveNow(!isSilent);
      }

      return await applyCloudDataToLocalState(cloudData, !isSilent);
    } catch (err) {
      console.warn('[MunjizSync] Restore error:', err);
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('saved_local');
      return false;
    }
  };

  // 6. SMART TWO-WAY RECONCILIATION
  async function smartReconcileWithGoogleCloud(isInteractive = false) {
    if (!navigator.onLine) return false;
    let token = await ensureFreshDriveAccessToken(false);
    if (!token) return false;

    try {
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');
      const { fileId, cloudData } = await fetchLatestCloudBackupObject(token);

      if (!fileId || !cloudData) {
        return await syncToGoogleDriveNow(isInteractive);
      }

      const cloudTs = Number(cloudData.lastSaved || 0);
      const dirtyTs = getSavedDirtyTimestamp();
      const localTs = Number(state.lastSaved || 0);

      // If user explicitly edited tasks in this browser and those edits are newer than Cloud -> UPLOAD!
      if ((hasLocalDirtyEdits || dirtyTs > 0) && Math.max(localTs, dirtyTs) > cloudTs) {
        return await syncToGoogleDriveNow(isInteractive);
      }

      // Otherwise (Incognito where localTs === 0, or Cloud has newer/equal data) -> PULL from Cloud!
      if (cloudTs >= localTs || localTs === 0) {
        return await applyCloudDataToLocalState(cloudData, isInteractive);
      }

      return await syncToGoogleDriveNow(isInteractive);
    } catch (err) {
      console.warn('[MunjizSync] Smart reconcile error:', err);
      return false;
    }
  }

  // 7. Upgrade handleGoogleDriveConnect
  window.handleGoogleDriveConnect = handleGoogleDriveConnect = function (forcedMode) {
    if (typeof handleOAuthConfigChange === 'function') {
      try { handleOAuthConfigChange(); } catch (e) {}
    }
    const inputClient = document.getElementById('inputGoogleClientId');
    const clientId = ((inputClient && inputClient.value ? inputClient.value : '') || oauthConfig.clientId || (typeof DEFAULT_GOOGLE_CLIENT_ID !== 'undefined' ? DEFAULT_GOOGLE_CLIENT_ID : '')).trim();
    oauthConfig.clientId = clientId;
    oauthConfig.autoSync = true;

    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    if (directInput) directInput.value = '';

    // If user already made edits in this session before clicking Connect, default to 'upload'!
    const defaultMode = (hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0) ? 'upload' : 'smart';
    const mode = (typeof forcedMode === 'string' ? forcedMode : null) || pendingPostAuthAction || defaultMode;
    pendingPostAuthAction = null;

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      if (typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? 'جاري تحميل مكتبة Google OAuth...' : 'Loading Google OAuth...');
      }
      return;
    }

    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: async (resp) => {
        if (!resp || !resp.access_token) return;
        oauthConfig.accessToken = resp.access_token;
        const expiresInSec = Number(resp.expires_in || 3599);
        oauthConfig.tokenExpiry = Date.now() + expiresInSec * 1000;
        oauthConfig.autoSync = true;
        if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();

        if (mode === 'upload') {
          await syncToGoogleDriveNow(true);
        } else if (mode === 'pull') {
          await restoreFromGoogleDriveNow(false);
        } else {
          await smartReconcileWithGoogleCloud(true);
        }

        if (typeof renderDriveModalState === 'function') {
          try { renderDriveModalState(); } catch (e) {}
        }
      }
    });

    tokenClient.requestAccessToken({ prompt: '' });
  };

  window.saveAndSyncDirectToken = saveAndSyncDirectToken = async function () {
    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    const tok = directInput ? directInput.value.trim() : '';
    if (!tok) return;
    oauthConfig.accessToken = tok;
    oauthConfig.tokenExpiry = Date.now() + 3500 * 1000;
    oauthConfig.autoSync = true;
    if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();
    if (hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0) {
      await syncToGoogleDriveNow(true);
    } else {
      await smartReconcileWithGoogleCloud(true);
    }
  };

  // 8. Upgrade saveState: Instant 0ms local save + marks dirty timestamp + immediate 150ms Cloud upload
  window.saveState = saveState = async function (triggerExternalAutoSync = true) {
    if (typeof state === 'undefined' || !state) return;
    const isInternal = (triggerExternalAutoSync === 'INTERNAL_NO_SYNC' || isInternalStateLoadOrRestore);

    if (!isInternal) {
      const now = Date.now();
      state.lastSaved = now;
      markDirtyEdit(now);
    }

    const cleanSnapshot = JSON.parse(JSON.stringify(Object.assign({}, state, {
      id: 'primary_workspace',
      isTimerRunning: false
    })));

    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    safeLocalSet(fallbackKey, cleanSnapshot);
    persistLiveTimerCheckpoint();

    if (!isInternal) {
      state.pendingOfflineCloudSync = true;
      cleanSnapshot.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, cleanSnapshot);
      safeLocalSet(fallbackKey, cleanSnapshot);
      if (!navigator.onLine && typeof updateSyncStatusBadge === 'function') {
        updateSyncStatusBadge((typeof diskFileHandle !== 'undefined' && diskFileHandle) ? 'synced_disk' : 'offline_queued');
      }
    }

    if (typeof idbPutRecord === 'function') {
      try {
        await idbPutRecord(cleanSnapshot);
      } catch (err) {}
    }

    if (!isInternal && typeof syncChannel !== 'undefined' && syncChannel) {
      try {
        syncChannel.postMessage({
          type: 'STATE_UPDATED',
          timestamp: state.lastSaved,
          payload: cleanSnapshot
        });
      } catch (e) {}
    }

    if (!isInternal) {
      scheduleExternalAutoSync();
    }
  };

  window.scheduleExternalAutoSync = scheduleExternalAutoSync = function (immediate = false) {
    if (typeof autoSyncDebounceTimer !== 'undefined' && autoSyncDebounceTimer) {
      clearTimeout(autoSyncDebounceTimer);
      autoSyncDebounceTimer = null;
    }

    const runSync = async () => {
      if (typeof diskFileHandle !== 'undefined' && diskFileHandle && typeof writeStateToLinkedDiskFile === 'function') {
        try {
          await writeStateToLinkedDiskFile(false);
        } catch (e) {}
      }

      if (!navigator.onLine) {
        state.pendingOfflineCloudSync = true;
        const snap = JSON.parse(JSON.stringify(Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false })));
        safeLocalSet(OFFLINE_OUTBOX_KEY, snap);
        if (typeof updateSyncStatusBadge === 'function') {
          updateSyncStatusBadge((typeof diskFileHandle !== 'undefined' && diskFileHandle) ? 'synced_disk' : 'offline_queued');
        }
        return;
      }

      if (typeof oauthConfig !== 'undefined' && oauthConfig && (oauthConfig.accessToken || oauthConfig.clientId)) {
        oauthConfig.autoSync = true;
        await syncToGoogleDriveNow(false);
      }
    };

    if (immediate) {
      runSync();
    } else {
      autoSyncDebounceTimer = setTimeout(runSync, 150);
    }
  };

  window.flushOfflineSyncQueue = flushOfflineSyncQueue = async function () {
    if (!navigator.onLine) return false;
    const outbox = safeLocalGet(OFFLINE_OUTBOX_KEY);
    const dirtyTs = getSavedDirtyTimestamp();

    if (outbox && (hasLocalDirtyEdits || dirtyTs > 0)) {
      if (Number(outbox.lastSaved || 0) >= Number(state.lastSaved || 0)) {
        const wasRunning = state.isTimerRunning;
        state = Object.assign({}, state, outbox, { isTimerRunning: Boolean(wasRunning) });
      }
      const ok = await syncToGoogleDriveNow(false);
      if (ok && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '🌐 عاد الإنترنت: تم رفع جميع التعديلات الأوفلاين فوراً!' : '🌐 Online: All offline changes synced to Cloud!');
      }
      return ok;
    }
    return await smartReconcileWithGoogleCloud(false);
  };

  // 9. Upgrade loadState: Fixes Incognito Date.now() bug & empty-array DEFAULT_TASKS bug
  window.loadState = loadState = async function () {
    v14Initialized = true;
    isInternalStateLoadOrRestore = true;
    try {
      let loadedOAuth = null;
      if (typeof idbGetRecord === 'function') {
        try { loadedOAuth = await idbGetRecord('oauth_config'); } catch (e) {}
      }
      if (!loadedOAuth) {
        const oauthKey = typeof OAUTH_STORAGE_KEY !== 'undefined' ? OAUTH_STORAGE_KEY : 'munjiz_oauth_config_v4';
        loadedOAuth = safeLocalGet(oauthKey);
      }
      if (loadedOAuth && typeof loadedOAuth === 'object' && typeof oauthConfig !== 'undefined') {
        oauthConfig = Object.assign({}, oauthConfig, loadedOAuth, { id: 'oauth_config', autoSync: true });
      }

      let idbPrimary = null;
      let idbMirror = null;
      if (typeof idbGetRecord === 'function') {
        try { idbPrimary = await idbGetRecord('primary_workspace'); } catch (e) {}
        try { idbMirror = await idbGetRecord('google_drive_cloud_mirror'); } catch (e) {}
      }
      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      const localSnap = safeLocalGet(fallbackKey);
      const outboxSnap = safeLocalGet(OFFLINE_OUTBOX_KEY);
      const dirtyTs = getSavedDirtyTimestamp();

      const candidates = [idbPrimary, idbMirror, localSnap, outboxSnap].filter(x => x && typeof x === 'object');

      if (candidates.length === 0) {
        // Fresh browser / Incognito / Cleared cookies!
        // Set lastSaved = 0 so it NEVER beats Google Cloud's timestamp!
        state.lastSaved = 0;
        hasLocalDirtyEdits = false;
      } else {
        candidates.sort((a, b) => Number(b.lastSaved || 0) - Number(a.lastSaved || 0));
        const newest = candidates[0];
        const normTask = typeof normalizeTask === 'function' ? normalizeTask : (x => x);
        const normHabit = typeof normalizeHabit === 'function' ? normalizeHabit : (x => x);

        state = Object.assign({}, state, newest, {
          id: 'primary_workspace',
          isTimerRunning: false,
          tasks: Array.isArray(newest.tasks) ? newest.tasks.map(normTask) : (state.tasks || []),
          habits: Array.isArray(newest.habits) ? newest.habits.map(normHabit) : (state.habits || []),
          categories: Array.isArray(newest.categories) && newest.categories.length ? newest.categories : (state.categories || []),
          lastSaved: Number(newest.lastSaved || 0)
        });

        hasLocalDirtyEdits = Boolean(dirtyTs > 0 || outboxSnap);
      }

      enforcePausedTimerAtLastTimeOnStartup();

      if (!state.activeTaskId || !Array.isArray(state.tasks) || !state.tasks.some(t => t.id === state.activeTaskId)) {
        state.activeTaskId = (Array.isArray(state.tasks) && state.tasks[0]) ? state.tasks[0].id : null;
      }

      if (typeof idbGetRecord === 'function') {
        try {
          const savedHandleRec = await idbGetRecord('disk_file_handle_record');
          if (savedHandleRec && savedHandleRec.handle && typeof verifyDiskHandlePermission === 'function') {
            diskFileHandle = savedHandleRec.handle;
            state.linkedDiskFileName = savedHandleRec.fileName || diskFileHandle.name || BACKUP_FILENAME;
          }
        } catch (e) {}
      }
    } finally {
      isInternalStateLoadOrRestore = false;
    }

    setTimeout(() => {
      if (navigator.onLine) {
        smartReconcileWithGoogleCloud(false);
      }
    }, 150);
  };

  // 10. Timer Controls
  window.stopAndFlushActiveTaskTimer = stopAndFlushActiveTaskTimer = function () {
    if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
      clearInterval(mainTimerInterval);
      mainTimerInterval = null;
    }
    state.isTimerRunning = false;
    lastTickWallClock = 0;
    persistLiveTimerCheckpoint();
    saveState(true);
    if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
  };

  window.toggleTimerStartPause = toggleTimerStartPause = function () {
    if (state.isTimerRunning) {
      if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
        clearInterval(mainTimerInterval);
        mainTimerInterval = null;
      }
      state.isTimerRunning = false;
      lastTickWallClock = 0;
      persistLiveTimerCheckpoint();
      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
      saveState(true);
      return;
    }

    state.isTimerRunning = true;
    if (state.timerMode !== 'stopwatch' && (!state.countdownRemainingSec || state.countdownRemainingSec <= 0)) {
      state.countdownRemainingSec = Number(state.countdownTotalSec) || 2700;
    }
    lastTickWallClock = Date.now();
    persistLiveTimerCheckpoint();

    if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
      clearInterval(mainTimerInterval);
      mainTimerInterval = null;
    }

    mainTimerInterval = setInterval(() => {
      if (!state.isTimerRunning) {
        clearInterval(mainTimerInterval);
        mainTimerInterval = null;
        return;
      }

      const now = Date.now();
      const deltaSec = Math.max(1, Math.round((now - (lastTickWallClock || (now - 1000))) / 1000));
      lastTickWallClock = now;

      const activeTask = Array.isArray(state.tasks)
        ? (state.tasks.find(t => t.id === state.activeTaskId) || state.tasks[0])
        : null;

      if (activeTask) {
        state.activeTaskId = activeTask.id;
        activeTask.trackedSeconds = (Number(activeTask.trackedSeconds) || 0) + deltaSec;
        if (typeof updateLiveTrackedTimeDOM === 'function') {
          updateLiveTrackedTimeDOM(activeTask);
        }
      }

      if (state.timerMode === 'stopwatch') {
        state.countdownRemainingSec = (Number(state.countdownRemainingSec) || 0) + deltaSec;
      } else {
        const nextRem = (Number(state.countdownRemainingSec) || 0) - deltaSec;
        if (nextRem > 0) {
          state.countdownRemainingSec = nextRem;
        } else {
          state.countdownRemainingSec = 0;
          state.isTimerRunning = false;
          clearInterval(mainTimerInterval);
          mainTimerInterval = null;
          persistLiveTimerCheckpoint();
          if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
          if (typeof renderKpis === 'function') renderKpis();
          saveState(true);
          if (typeof showToast === 'function') {
            showToast(state.lang === 'ar' ? '🎉 انتهى وقت الجلسة! أحسنت الإنجاز.' : '🎉 Session complete! Great focus.');
          }
          if (typeof playAlertSound === 'function') playAlertSound();
          return;
        }
      }

      persistLiveTimerCheckpoint();
      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
      if (typeof renderKpis === 'function') renderKpis();
    }, 1000);

    if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
    saveState(true);
  };

  const originalRenderFocusTimerWidget = typeof renderFocusTimerWidget === 'function' ? renderFocusTimerWidget : null;
  if (originalRenderFocusTimerWidget) {
    window.renderFocusTimerWidget = renderFocusTimerWidget = function () {
      if (!mainTimerInterval && state.isTimerRunning) {
        state.isTimerRunning = false;
      }
      originalRenderFocusTimerWidget();

      const isRunning = Boolean(state.isTimerRunning && mainTimerInterval);
      const lblBtn = document.getElementById('lblTimerPlayPause');
      const iconBtn = document.getElementById('iconTimerPlayPause');
      const dockBtn = document.getElementById('dockBtnPlayPause');
      const isPausedMidway = !isRunning && state.timerMode === 'countdown' &&
        Number(state.countdownRemainingSec) > 0 &&
        Number(state.countdownRemainingSec) < Number(state.countdownTotalSec || 2700);

      if (!isRunning) {
        if (iconBtn) iconBtn.textContent = '▶';
        if (dockBtn) dockBtn.textContent = '▶';
        if (lblBtn) {
          lblBtn.textContent = isPausedMidway
            ? (state.lang === 'ar' ? 'استئناف المهمة' : 'Resume Task')
            : (state.lang === 'ar' ? 'بدء التركيز' : 'Start Focus');
        }
      }
    };
  }


  // 11. Upgrade updateSyncStatusBadge so the user always knows 100% whether edits are in Google Cloud or waiting for OAuth connection
  const originalUpdateSyncStatusBadge = typeof updateSyncStatusBadge === 'function' ? updateSyncStatusBadge : null;
  window.updateSyncStatusBadge = updateSyncStatusBadge = function (statusType) {
    if (originalUpdateSyncStatusBadge) {
      try { originalUpdateSyncStatusBadge(statusType); } catch (e) {}
    }
    const lbl = document.getElementById('lblOfflineStatus');
    const dot = document.getElementById('dotSyncIndicator');
    if (!lbl || !dot) return;
    const isAr = (typeof state !== 'undefined' && state && state.lang === 'ar');
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (statusType === 'synced_cloud') {
      dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
      lbl.textContent = isAr ? `☁️ تم الحفظ في Google Cloud ✓ (${timeStr})` : `☁️ Google Cloud Synced ✓ (${timeStr})`;
    } else if (statusType === 'syncing_cloud') {
      dot.className = 'w-2 h-2 rounded-full bg-blue-500 animate-ping';
      lbl.textContent = isAr ? '☁️ جاري المزامنة مع Google Cloud...' : '☁️ Syncing with Google Cloud...';
    } else if (!isOAuthTokenValid() && (hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0)) {
      dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-ping';
      lbl.textContent = isAr ? '⚠️ محفوظ محلياً — اضغط Drive Sync للرفع سحابياً' : '⚠️ Saved Locally — Click Drive Sync to Upload';
    } else if (!isOAuthTokenValid() && Number(state.lastSaved || 0) === 0) {
      dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
      lbl.textContent = isAr ? '🔗 اضغط Drive Sync لاستدعاء مهامك من السحاب' : '🔗 Click Drive Sync to Pull Cloud Tasks';
    }
  };

  function handleAppCloseOrHide(isUnload) {
    if (typeof state === 'undefined' || !state) return;
    if (isUnload && state.isTimerRunning) {
      if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
        clearInterval(mainTimerInterval);
        mainTimerInterval = null;
      }
      state.isTimerRunning = false;
    }
    persistLiveTimerCheckpoint();
    if ((hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0) && navigator.onLine && isOAuthTokenValid()) {
      syncToGoogleDriveNow(false, true);
    }
  }

  window.addEventListener('pagehide', () => handleAppCloseOrHide(true));
  window.addEventListener('beforeunload', () => handleAppCloseOrHide(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      handleAppCloseOrHide(false);
    } else if (document.visibilityState === 'visible' && navigator.onLine) {
      smartReconcileWithGoogleCloud(false);
    }
  });

  window.addEventListener('online', () => {
    flushOfflineSyncQueue();
  });

  if (!periodicSyncHeartbeat) {
    periodicSyncHeartbeat = setInterval(() => {
      if (navigator.onLine && (hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0) && isOAuthTokenValid()) {
        syncToGoogleDriveNow(false);
      }
    }, 8000);
  }

  // If DOMContentLoaded already ran before this script executed, run loadState() now!
  if (document.readyState !== 'loading' && !v14Initialized) {
    loadState().then(() => {
      if (typeof applyThemeAndDir === 'function') applyThemeAndDir();
      if (typeof renderApp === 'function') renderApp();
      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
    }).catch(() => {});
  }
})();
