/* ============================================================================
 * MUNJIZ PLANNER — ROOT-CAUSE SYNC & TIMER RECOVERY ENGINE (v12.0)
 * Fixes:
 * 1) Sudden close / reload Timer Bug: Always restores exact last second in
 *    PAUSED/STOPPED state (isTimerRunning = false) with Start/Resume button ready.
 * 2) Moment-by-moment real-time auto-sync (0ms local save + 350ms cloud sync).
 * 3) Offline durable persistence (IndexedDB + localStorage Outbox) & instant
 *    auto-upload upon internet reconnection (online / focus / heartbeat).
 * ============================================================================ */
(function () {
  if (window.__MUNJIZ_ROOT_FIX_V12_APPLIED__) return;
  window.__MUNJIZ_ROOT_FIX_V12_APPLIED__ = true;

  const LIVE_TIMER_SNAPSHOT_KEY = 'munjiz_live_timer_snapshot_v12';
  const OFFLINE_OUTBOX_KEY = 'munjiz_offline_outbox_v12';
  const BACKUP_FILENAME = typeof DRIVE_BACKUP_FILENAME !== 'undefined' ? DRIVE_BACKUP_FILENAME : 'munjiz_planner_backup.json';

  let silentRefreshPromise = null;
  let periodicSyncHeartbeat = null;
  let lastTickWallClock = 0;

  // Helper: safely write to localStorage
  function safeLocalSet(key, val) {
    try {
      localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
      return true;
    } catch (err) {
      console.warn('[MunjizSync] localStorage write warning:', err);
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

  // Helper: save live timer second checkpoint (ALWAYS with isTimerRunning: false for crash recovery)
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

    // Also keep localStorage fallback state updated with isTimerRunning: false on disk
    // so sudden browser close never leaves isTimerRunning = true in persisted storage
    try {
      const diskState = Object.assign({}, state, {
        isTimerRunning: false,
        lastSaved: Date.now()
      });
      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      safeLocalSet(fallbackKey, diskState);
      if (typeof idbPutRecord === 'function') {
        idbPutRecord(Object.assign({}, diskState, { id: 'primary_workspace' })).catch(() => {});
      }
    } catch (e) {}
  }

  // Helper: merge any newer timer checkpoint into state on startup and force PAUSED state
  function enforcePausedTimerAtLastTimeOnStartup() {
    if (typeof state === 'undefined' || !state) return;

    // 1. Always stop any running interval and force paused state on app open
    if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
      clearInterval(mainTimerInterval);
      mainTimerInterval = null;
    }
    state.isTimerRunning = false;

    // 2. Restore exact second from live checkpoint if newer or valid
    const cp = safeLocalGet(LIVE_TIMER_SNAPSHOT_KEY);
    if (cp && typeof cp === 'object') {
      const stateSavedAt = Number(state.lastSaved || 0);
      if ((cp.savedAt || 0) >= stateSavedAt - 5000) {
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

  // Silent token renewal using Google Identity Services if token expired
  async function ensureFreshDriveAccessToken(interactiveAllowed = false) {
    if (typeof oauthConfig === 'undefined' || !oauthConfig) return null;

    // Check existing valid token (with 60s safety buffer)
    if (oauthConfig.accessToken && Date.now() < (Number(oauthConfig.tokenExpiry || 0) - 60000)) {
      return oauthConfig.accessToken;
    }

    // Check if user pasted a direct token in the UI input
    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    if (directInput && directInput.value && directInput.value.trim().startsWith('ya29.')) {
      const manualTok = directInput.value.trim();
      if (manualTok !== oauthConfig.accessToken) {
        oauthConfig.accessToken = manualTok;
        oauthConfig.tokenExpiry = Date.now() + 3500 * 1000;
        if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
        return oauthConfig.accessToken;
      }
    }

    // Attempt silent refresh via Google Identity Services if clientId is configured
    const clientId = (oauthConfig.clientId || (typeof DEFAULT_GOOGLE_CLIENT_ID !== 'undefined' ? DEFAULT_GOOGLE_CLIENT_ID : '')).trim();
    if (!clientId || !window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      return oauthConfig.accessToken || null;
    }

    if (silentRefreshPromise) return silentRefreshPromise;

    silentRefreshPromise = new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          silentRefreshPromise = null;
          resolve(oauthConfig.accessToken || null);
        }
      }, 6500);

      try {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          prompt: interactiveAllowed ? 'consent' : '',
          hint: oauthConfig.userEmail || undefined,
          callback: (resp) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            silentRefreshPromise = null;
            if (resp && resp.access_token) {
              oauthConfig.accessToken = resp.access_token;
              const expiresIn = Number(resp.expires_in || 3599);
              oauthConfig.tokenExpiry = Date.now() + expiresIn * 1000;
              oauthConfig.autoSync = true;
              if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
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
        tokenClient.requestAccessToken({ prompt: interactiveAllowed ? 'consent' : '' });
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        silentRefreshPromise = null;
        resolve(null);
      }
    });

    return silentRefreshPromise;
  }

  // Upgrade saveState: ALWAYS synchronous local write (0ms) + IDB write + Continuous Auto-Sync
  window.saveState = saveState = async function (triggerExternalAutoSync = true) {
    if (typeof state === 'undefined' || !state) return;
    const now = Date.now();
    state.lastSaved = now;

    // 1. Always persist a clean snapshot with isTimerRunning: false to disk storage
    // so that if the app is killed or closed suddenly, reopening never shows a frozen running timer
    const cleanSnapshot = JSON.parse(JSON.stringify(Object.assign({}, state, {
      id: 'primary_workspace',
      isTimerRunning: false,
      lastSaved: now
    })));

    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    safeLocalSet(fallbackKey, cleanSnapshot);
    persistLiveTimerCheckpoint();

    // 2. If offline, immediately mark pendingOfflineCloudSync and store in durable outbox
    if (!navigator.onLine) {
      state.pendingOfflineCloudSync = true;
      cleanSnapshot.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, cleanSnapshot);
      safeLocalSet(fallbackKey, cleanSnapshot);
      if (typeof updateSyncStatusBadge === 'function') {
        updateSyncStatusBadge((typeof diskFileHandle !== 'undefined' && diskFileHandle) ? 'synced_disk' : 'offline_queued');
      }
    } else if (typeof oauthConfig !== 'undefined' && (oauthConfig.accessToken || oauthConfig.clientId || oauthConfig.driveFileId)) {
      // Mark pending until cloud sync confirms completion
      state.pendingOfflineCloudSync = true;
      cleanSnapshot.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, cleanSnapshot);
    }

    // 3. Persist to IndexedDB immediately
    if (typeof idbPutRecord === 'function') {
      try {
        await idbPutRecord(cleanSnapshot);
      } catch (err) {
        console.warn('[MunjizSync] IDB put warning:', err);
      }
    }

    // 4. Broadcast to other open tabs immediately
    if (typeof syncChannel !== 'undefined' && syncChannel) {
      try {
        syncChannel.postMessage({
          type: 'STATE_UPDATED',
          timestamp: now,
          payload: cleanSnapshot
        });
      } catch (e) {}
    }

    // 5. ALWAYS schedule external auto-sync (even if caller passed false, unless explicitly suppressed by internal restore)
    if (triggerExternalAutoSync !== 'INTERNAL_NO_SYNC') {
      scheduleExternalAutoSync();
    }
  };

  // Fast 350ms continuous auto-sync scheduler
  window.scheduleExternalAutoSync = scheduleExternalAutoSync = function (immediate = false) {
    if (typeof autoSyncDebounceTimer !== 'undefined' && autoSyncDebounceTimer) {
      clearTimeout(autoSyncDebounceTimer);
      autoSyncDebounceTimer = null;
    }

    const runSync = async () => {
      // 1) Local Disk File auto-write if linked
      if (typeof diskFileHandle !== 'undefined' && diskFileHandle && typeof writeStateToLinkedDiskFile === 'function') {
        try {
          await writeStateToLinkedDiskFile(false);
        } catch (e) {}
      }

      // 2) Check online status
      if (!navigator.onLine) {
        state.pendingOfflineCloudSync = true;
        const snap = JSON.parse(JSON.stringify(Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false })));
        safeLocalSet(OFFLINE_OUTBOX_KEY, snap);
        if (typeof idbPutRecord === 'function') {
          idbPutRecord(snap).catch(() => {});
        }
        if (typeof updateSyncStatusBadge === 'function') {
          updateSyncStatusBadge((typeof diskFileHandle !== 'undefined' && diskFileHandle) ? 'synced_disk' : 'offline_queued');
        }
        return;
      }

      // 3) Sync to Google Drive if connected or autoSync enabled
      if (typeof oauthConfig !== 'undefined' && oauthConfig) {
        if (oauthConfig.accessToken || oauthConfig.driveFileId) {
          oauthConfig.autoSync = true;
        }
        if (oauthConfig.autoSync && (oauthConfig.accessToken || oauthConfig.clientId)) {
          await syncToGoogleDriveNow(false);
        }
      }
    };

    if (immediate) {
      runSync();
    } else {
      autoSyncDebounceTimer = setTimeout(runSync, 350);
    }
  };

  // Robust Google Drive Upload with keepalive support, 401 token auto-refresh, and 404 file recreation
  window.syncToGoogleDriveNow = syncToGoogleDriveNow = async function (isManual = false, useKeepalive = false) {
    if (typeof isCloudSyncInProgress !== 'undefined' && isCloudSyncInProgress && !useKeepalive) return false;

    if (!navigator.onLine) {
      state.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '📦 لا يوجد اتصال بالإنترنت — تم حفظ التعديلات أوفلاين وستُرفع تلقائياً فور عودة الإنترنت' : '📦 Offline — Changes saved locally & queued for instant upload');
      }
      return false;
    }

    if (typeof isCloudSyncInProgress !== 'undefined') isCloudSyncInProgress = true;
    if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');

    try {
      let token = await ensureFreshDriveAccessToken(isManual);
      if (!token) {
        state.pendingOfflineCloudSync = true;
        if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
        return false;
      }

      const payloadObj = JSON.parse(JSON.stringify(Object.assign({}, state, {
        id: 'primary_workspace',
        isTimerRunning: false,
        pendingOfflineCloudSync: false,
        lastSaved: Number(state.lastSaved || Date.now())
      })));
      const fileContent = JSON.stringify(payloadObj, null, 2);

      let fileId = oauthConfig.driveFileId || null;
      if (!fileId && typeof findDriveBackupFileId === 'function' && !useKeepalive) {
        try {
          fileId = await findDriveBackupFileId(token);
          if (fileId) oauthConfig.driveFileId = fileId;
        } catch (e) {}
      }

      const uploadOnce = async (activeToken, targetFileId) => {
        const metadata = { name: BACKUP_FILENAME, mimeType: 'application/json' };
        const boundary = '-------MunjizSyncBoundaryV12';
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
        if (useKeepalive && multipartBody.length < 60000) {
          fetchOpts.keepalive = true;
        }
        return fetch(url, fetchOpts);
      };

      let res = await uploadOnce(token, fileId);

      // If fileId was deleted or inaccessible (404/403), recreate file
      if ((res.status === 404 || res.status === 403) && fileId) {
        oauthConfig.driveFileId = null;
        fileId = null;
        res = await uploadOnce(token, null);
      }

      // If token expired (401), clear token and try one silent refresh
      if (res.status === 401) {
        oauthConfig.accessToken = '';
        oauthConfig.tokenExpiry = 0;
        token = await ensureFreshDriveAccessToken(isManual);
        if (token) {
          res = await uploadOnce(token, fileId);
        }
      }

      if (!res.ok) {
        throw new Error(`Drive API HTTP ${res.status}`);
      }

      const data = await res.json().catch(() => ({}));
      if (data && data.id) {
        oauthConfig.driveFileId = data.id;
      }
      oauthConfig.lastCloudSync = Date.now();
      oauthConfig.autoSync = true;
      state.pendingOfflineCloudSync = false;
      try { localStorage.removeItem(OFFLINE_OUTBOX_KEY); } catch (e) {}

      if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
      if (typeof idbPutRecord === 'function') {
        idbPutRecord(Object.assign({}, payloadObj, { id: 'primary_workspace' })).catch(() => {});
        idbPutRecord(Object.assign({}, payloadObj, { id: 'google_drive_cloud_mirror' })).catch(() => {});
      }
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');

      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '☁️ تمت المزامنة الفورية مع Google Drive بنجاح' : '☁️ Synced with Google Drive');
      }
      return true;
    } catch (err) {
      console.warn('[MunjizSync] Cloud sync deferred to offline queue:', err);
      state.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      return false;
    } finally {
      if (typeof isCloudSyncInProgress !== 'undefined') isCloudSyncInProgress = false;
    }
  };

  // Flush offline queue immediately upon internet restoration
  window.flushOfflineSyncQueue = flushOfflineSyncQueue = async function () {
    if (!navigator.onLine) return false;
    const outbox = safeLocalGet(OFFLINE_OUTBOX_KEY);
    if (outbox && Number(outbox.lastSaved || 0) > Number(state.lastSaved || 0)) {
      const wasRunning = state.isTimerRunning;
      state = Object.assign({}, state, outbox, { isTimerRunning: Boolean(wasRunning) });
    }
    if (!state.pendingOfflineCloudSync && !outbox) return false;

    const ok = await syncToGoogleDriveNow(false);
    if (ok && typeof showToast === 'function') {
      showToast(state.lang === 'ar' ? '🌐 عاد الإنترنت: تم رفع جميع التعديلات الأوفلاين تلقائياً!' : '🌐 Online: All offline changes synced to Cloud!');
    }
    return ok;
  };

  // Bidirectional startup reconciliation: if local has pending offline edits, push them; otherwise pull newer cloud backup
  async function reconcileCloudAndLocalOnStartup() {
    if (!navigator.onLine || typeof oauthConfig === 'undefined' || !oauthConfig) return;
    if (!oauthConfig.accessToken && !oauthConfig.clientId) return;

    const outbox = safeLocalGet(OFFLINE_OUTBOX_KEY);
    if (state.pendingOfflineCloudSync || outbox) {
      await flushOfflineSyncQueue();
      return;
    }

    // Check if Google Drive has a newer backup than our local state
    try {
      const token = await ensureFreshDriveAccessToken(false);
      if (!token) return;
      let fileId = oauthConfig.driveFileId;
      if (!fileId && typeof findDriveBackupFileId === 'function') {
        fileId = await findDriveBackupFileId(token);
      }
      if (!fileId) return;

      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (!res.ok) return;
      const cloudData = await res.json();
      if (cloudData && Number(cloudData.lastSaved || 0) > Number(state.lastSaved || 0) + 1000) {
        state = Object.assign({}, state, cloudData, { isTimerRunning: false });
        enforcePausedTimerAtLastTimeOnStartup();
        await saveState('INTERNAL_NO_SYNC');
        if (typeof applyThemeAndDir === 'function') applyThemeAndDir();
        if (typeof renderApp === 'function') renderApp();
        if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');
      }
    } catch (e) {}
  }

  // Upgrade loadState: restore newest local/outbox/IDB record + FORCE timer into PAUSED state at last time
  const originalLoadState = typeof loadState === 'function' ? loadState : null;
  window.loadState = loadState = async function () {
    if (originalLoadState) {
      try {
        await originalLoadState();
      } catch (e) {
        console.warn('[MunjizSync] originalLoadState fallback:', e);
      }
    }

    // Check if localStorage fallback or offline outbox is newer than what IDB had
    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    const localSnap = safeLocalGet(fallbackKey);
    const outboxSnap = safeLocalGet(OFFLINE_OUTBOX_KEY);

    let newestLocal = null;
    if (localSnap && outboxSnap) {
      newestLocal = Number(outboxSnap.lastSaved || 0) >= Number(localSnap.lastSaved || 0) ? outboxSnap : localSnap;
    } else {
      newestLocal = outboxSnap || localSnap;
    }

    if (newestLocal && Number(newestLocal.lastSaved || 0) >= Number(state.lastSaved || 0)) {
      state = Object.assign({}, state, newestLocal);
    }

    // CRITICAL FIX: Always restore timer at its last saved second in PAUSED state (isTimerRunning = false)
    enforcePausedTimerAtLastTimeOnStartup();

    // Ensure autoSync stays active if credentials exist
    if (typeof oauthConfig !== 'undefined' && oauthConfig && (oauthConfig.accessToken || oauthConfig.driveFileId || oauthConfig.clientId)) {
      oauthConfig.autoSync = true;
    }

    // Persist the clean paused state locally
    await saveState('INTERNAL_NO_SYNC');

    // Trigger cloud reconciliation in background
    setTimeout(() => {
      reconcileCloudAndLocalOnStartup();
    }, 400);
  };

  // Upgrade Timer Functions: drift-free wall-clock delta + per-second checkpointing + clean pause/resume
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
      // Pause timer at exact current second
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

    // Start / Resume timer from the current countdownRemainingSec
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

      // Persist live second checkpoint EVERY second (with isTimerRunning: false on disk!)
      persistLiveTimerCheckpoint();

      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
      if (typeof renderKpis === 'function') renderKpis();
    }, 1000);

    if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
    saveState(true);
  };

  // Ensure Play/Pause button UI always reflects paused/ready state accurately
  const originalRenderFocusTimerWidget = typeof renderFocusTimerWidget === 'function' ? renderFocusTimerWidget : null;
  if (originalRenderFocusTimerWidget) {
    window.renderFocusTimerWidget = renderFocusTimerWidget = function () {
      // Guard: if mainTimerInterval is null, state.isTimerRunning MUST be false
      if (!mainTimerInterval && state.isTimerRunning) {
        state.isTimerRunning = false;
      }
      originalRenderFocusTimerWidget();

      // Ensure button labels clearly show Resume/Start when paused on an in-progress countdown
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
          if (isPausedMidway) {
            lblBtn.textContent = state.lang === 'ar' ? 'استئناف المهمة' : 'Resume Task';
          } else {
            lblBtn.textContent = state.lang === 'ar' ? 'بدء التركيز' : 'Start Focus';
          }
        }
      }
    };
  }

  // Sudden close / unload handlers: freeze timer at current second in PAUSED mode & flush state
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
    const snap = JSON.parse(JSON.stringify(Object.assign({}, state, {
      id: 'primary_workspace',
      isTimerRunning: false,
      lastSaved: Date.now()
    })));
    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    safeLocalSet(fallbackKey, snap);
    safeLocalSet(OFFLINE_OUTBOX_KEY, snap);
    if (typeof idbPutRecord === 'function') {
      idbPutRecord(snap).catch(() => {});
    }
    if (navigator.onLine && typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.accessToken) {
      syncToGoogleDriveNow(false, true);
    }
  }

  window.addEventListener('pagehide', () => handleAppCloseOrHide(true));
  window.addEventListener('beforeunload', () => handleAppCloseOrHide(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      handleAppCloseOrHide(false);
    } else if (document.visibilityState === 'visible') {
      if (navigator.onLine) {
        flushOfflineSyncQueue();
      }
    }
  });

  // Online / Offline instant listeners + 12-second recovery heartbeat
  window.addEventListener('online', () => {
    flushOfflineSyncQueue();
  });

  window.addEventListener('focus', () => {
    if (navigator.onLine && state && state.pendingOfflineCloudSync) {
      flushOfflineSyncQueue();
    }
  });

  if (!periodicSyncHeartbeat) {
    periodicSyncHeartbeat = setInterval(() => {
      if (navigator.onLine && typeof state !== 'undefined' && state && state.pendingOfflineCloudSync) {
        flushOfflineSyncQueue();
      }
    }, 12000);
  }

  // If DOM already loaded, enforce paused timer immediately
  if (document.readyState !== 'loading') {
    enforcePausedTimerAtLastTimeOnStartup();
    if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
  }
})();
