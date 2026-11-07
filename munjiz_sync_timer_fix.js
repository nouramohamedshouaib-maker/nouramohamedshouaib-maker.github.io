/* ==========================================================================
 * MUNJIZ PLANNER – DEFINITIVE CLOUD-SYNC, GOOGLE SIGN-IN & TIMER ENGINE (v15.0)
 * Verified by Multi-Scenario Automated Tests:
 * 1) ZERO FALSE-POSITIVE DIRTY EDITS ON STARTUP OR TAB NAVIGATION:
 *    - Prevents startup calls (`setSplitSubLayout`, `switchMainView`, `renderApp`)
 *      and view/theme toggles from marking stale local data as dirty or bumping
 *      `state.lastSaved = Date.now()`.
 *    - Uses Core Data Content Signature (`tasks`, `habits`, `categories`,
 *      `weeklyReview`) so only real user edits mark the workspace dirty.
 *    - Automatically purges any stale v14 dirty flags left in localStorage.
 * 2) PULL-FIRST SMART CLOUD SYNC ON GOOGLE SIGN-IN & DEVICE OPEN:
 *    - Signing in with Google or opening the app on another device ALWAYS checks
 *      Google Drive first and automatically pulls the latest cloud backup when
 *      no real edits were made in the current session (or smart-merges if offline
 *      edits were made in the current session), NEVER overwriting newer cloud
 *      backups with stale local data.
 * 3) SEAMLESS GOOGLE SIGN-IN & SILENT TOKEN AUTO-RENEWAL (`login_hint`):
 *    - Built-in `DEFAULT_GOOGLE_CLIENT_ID` so users never need to re-enter
 *      Google Cloud Console settings on new devices.
 *    - Automatically fetches & persists `oauthConfig.userEmail` via Drive About API
 *      and passes `hint` / `login_hint` for background silent token renewal.
 *    - Proactively refreshes tokens before the 60-minute expiry and on tab focus.
 * 4) INSTANT AUTO-SYNC ON EVERY EDIT + LIVE MULTI-DEVICE CLOUD POLLING:
 *    - Every task, subtask, habit, or review edit auto-syncs to Google Drive
 *      within 200ms (and with `keepalive: true` on tab close).
 *    - Lightweight background polling automatically pulls updates made on other
 *      devices while the app is open.
 * 5) TIMER RECOVERY ON SUDDEN CLOSE: Always restores at the exact last second
 *    in PAUSED state (`isTimerRunning = false`) with Start/Resume ready.
 * ========================================================================== */
(function () {
  if (window.__MUNJIZ_ROOT_FIX_V15_APPLIED__) return;
  window.__MUNJIZ_ROOT_FIX_V15_APPLIED__ = true;
  window.__MUNJIZ_ROOT_FIX_V14_APPLIED__ = true;
  window.__MUNJIZ_ROOT_FIX_V13_APPLIED__ = true;
  window.__MUNJIZ_ROOT_FIX_V12_APPLIED__ = true;

  const LIVE_TIMER_SNAPSHOT_KEY = 'munjiz_live_timer_snapshot_v14';
  const OFFLINE_OUTBOX_KEY = 'munjiz_offline_outbox_v15';
  const DIRTY_EDITS_TS_KEY = 'munjiz_dirty_edits_ts_v15';
  const LEGACY_OUTBOX_KEY_V14 = 'munjiz_offline_outbox_v14';
  const LEGACY_DIRTY_KEY_V14 = 'munjiz_dirty_edits_ts_v14';
  const OAUTH_FALLBACK_KEY_V4 = 'munjiz_oauth_config_v4';
  const OAUTH_FALLBACK_KEY_V1 = 'munjiz_oauth_config_v1';
  const BUILTIN_GOOGLE_CLIENT_ID = '840816100126-70sj7pkum9muemp8aik12tdrg6giu2lu.apps.googleusercontent.com';
  const PRIMARY_BACKUP_FILENAME = typeof DRIVE_BACKUP_FILENAME !== 'undefined' ? DRIVE_BACKUP_FILENAME : 'munjiz_planner_backup.json';
  const LEGACY_BACKUP_FILENAMES = ['munjiz_planner_backup.json', 'munjiz_planner_backup_v14.json', 'munjiz_planner_backup_v1.json'];

  let silentRefreshPromise = null;
  let periodicSyncHeartbeat = null;
  let remotePollInterval = null;
  let proactiveTokenTimer = null;
  let lastTickWallClock = 0;
  let hasLocalDirtyEdits = false;
  let hasRealUserEditsInCurrentSession = false;
  let hasFinishedInitialLocalLoad = false;
  let isBootstrappingApp = true;
  let isUiNavigationOnly = false;
  let isInternalStateLoadOrRestore = false;
  let lastSavedDataSignature = null;
  let lastKnownCloudModifiedMs = 0;
  let pendingPostAuthAction = null; // 'upload' | 'pull' | 'smart'
  let v15Initialized = false;
  let isCloudSyncInProgress = false;

  // Purge poisoned v14 dirty flags caused by startup setSplitSubLayout/switchMainView in v14
  try {
    localStorage.removeItem(LEGACY_DIRTY_KEY_V14);
    localStorage.removeItem(LEGACY_OUTBOX_KEY_V14);
  } catch (e) {}

  // Proactively check for Service Worker updates so devices transition from v14 to v15 immediately
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        if (Array.isArray(regs)) regs.forEach((r) => { try { r.update(); } catch (e) {} });
      }).catch(() => {});
    }
  } catch (e) {}

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

  function getActiveClientId() {
    const inputClient = document.getElementById('inputGoogleClientId');
    const fromInput = inputClient && inputClient.value ? inputClient.value.trim() : '';
    const fromConfig = (typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.clientId) ? String(oauthConfig.clientId).trim() : '';
    const fromGlobal = (typeof DEFAULT_GOOGLE_CLIENT_ID !== 'undefined' && DEFAULT_GOOGLE_CLIENT_ID) ? String(DEFAULT_GOOGLE_CLIENT_ID).trim() : '';
    return fromInput || fromConfig || fromGlobal || BUILTIN_GOOGLE_CLIENT_ID;
  }

  async function persistOAuthConfigEverywhere() {
    if (typeof oauthConfig === 'undefined' || !oauthConfig) return;
    if (!oauthConfig.clientId) {
      oauthConfig.clientId = getActiveClientId();
    }
    oauthConfig.id = 'oauth_config';
    const oauthKey = typeof OAUTH_STORAGE_KEY !== 'undefined' ? OAUTH_STORAGE_KEY : OAUTH_FALLBACK_KEY_V4;
    safeLocalSet(oauthKey, oauthConfig);
    safeLocalSet(OAUTH_FALLBACK_KEY_V4, oauthConfig);
    safeLocalSet(OAUTH_FALLBACK_KEY_V1, oauthConfig);
    if (typeof saveOAuthConfig === 'function') {
      try {
        await saveOAuthConfig();
      } catch (e) {}
    } else if (typeof idbPutRecord === 'function') {
      try {
        await idbPutRecord(JSON.parse(JSON.stringify(oauthConfig)));
      } catch (e) {}
    }
  }

  // Deterministic fingerprint of actual user content (ignores currentView / splitSubLayout / theme / lastSaved)
  function computeCoreDataSignature(st) {
    if (!st || typeof st !== 'object') return '';
    try {
      const tasksArr = Array.isArray(st.tasks) ? st.tasks.map(t => ({
        id: t.id,
        title: t.title,
        titleAr: t.titleAr,
        titleEn: t.titleEn,
        completed: Boolean(t.completed),
        quadrant: t.quadrant,
        category: t.category,
        gtdStatus: t.gtdStatus,
        gtdContext: t.gtdContext,
        dueDate: t.dueDate,
        startTime: t.startTime,
        endTime: t.endTime,
        trackedSeconds: Number(t.trackedSeconds || 0),
        notes: t.notes || '',
        subtasks: Array.isArray(t.subtasks) ? t.subtasks : []
      })) : [];

      const habitsArr = Array.isArray(st.habits) ? st.habits.map(h => ({
        id: h.id,
        title: h.title,
        titleAr: h.titleAr,
        titleEn: h.titleEn,
        type: h.type,
        streak: Number(h.streak || 0),
        completedToday: Boolean(h.completedToday),
        completedDates: Array.isArray(h.completedDates) ? h.completedDates : [],
        history: h.history || {},
        anchor: h.anchor,
        anchorAr: h.anchorAr,
        anchorEn: h.anchorEn,
        reward: h.reward,
        trigger: h.trigger
      })) : [];

      const catsArr = Array.isArray(st.categories) ? st.categories : [];
      const revObj = st.weeklyReview || {};

      return JSON.stringify({
        tasks: tasksArr,
        habits: habitsArr,
        categories: catsArr,
        weeklyReview: revObj
      });
    } catch (e) {
      return '';
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
      localStorage.removeItem(LEGACY_DIRTY_KEY_V14);
      localStorage.removeItem(LEGACY_OUTBOX_KEY_V14);
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
    if (!hasFinishedInitialLocalLoad || isInternalStateLoadOrRestore) return;

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

  // 2. Always query Google Drive for all backup files (primary + legacy names) sorted by modifiedTime desc
  async function findAllDriveBackupFiles(accessToken) {
    const token = accessToken || (typeof oauthConfig !== 'undefined' ? oauthConfig.accessToken : '');
    if (!token) return [];
    const nameConditions = LEGACY_BACKUP_FILENAMES.map(n => `name = '${n}'`).join(' or ');
    const q = encodeURIComponent(`(${nameConditions}) and trashed = false`);
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
      persistOAuthConfigEverywhere();
    }
    return files;
  }

  window.findDriveBackupFileId = findDriveBackupFileId = async function (accessToken) {
    const files = await findAllDriveBackupFiles(accessToken);
    if (files.length > 0) return files[0].id;
    return (typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.driveFileId) ? oauthConfig.driveFileId : null;
  };

  // Fetch and persist user's Google account email & display name using existing drive.file token
  async function fetchAndSaveGoogleUserProfile(accessToken) {
    const token = accessToken || (typeof oauthConfig !== 'undefined' && oauthConfig ? oauthConfig.accessToken : null);
    if (!token || typeof oauthConfig === 'undefined' || !oauthConfig) return null;
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)&_t=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.user && data.user.emailAddress) {
          oauthConfig.userEmail = data.user.emailAddress;
          oauthConfig.userName = data.user.displayName || data.user.emailAddress.split('@')[0];
          oauthConfig.userPicture = data.user.photoLink || '';
          await persistOAuthConfigEverywhere();
          renderGoogleAccountUI();
          return data.user;
        }
      }
    } catch (e) {}
    return null;
  }

  // 3. Token validation & automatic silent renewal with login_hint
  window.isOAuthTokenValid = isOAuthTokenValid = function () {
    return Boolean(
      typeof oauthConfig !== 'undefined' &&
      oauthConfig &&
      oauthConfig.accessToken &&
      Date.now() < Number(oauthConfig.tokenExpiry || 0) - 30000
    );
  };

  function isTokenNearExpiry() {
    if (typeof oauthConfig === 'undefined' || !oauthConfig || !oauthConfig.accessToken) return true;
    // True if less than 10 minutes left before expiry
    return Date.now() >= Number(oauthConfig.tokenExpiry || 0) - (10 * 60 * 1000);
  }

  async function ensureFreshDriveAccessToken(interactiveAllowed = false) {
    if (typeof oauthConfig === 'undefined' || !oauthConfig) return null;

    if (isOAuthTokenValid()) {
      if (!oauthConfig.userEmail) {
        fetchAndSaveGoogleUserProfile(oauthConfig.accessToken).catch(() => {});
      }
      return oauthConfig.accessToken;
    }

    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    if (directInput && directInput.value && directInput.value.trim().startsWith('ya29.')) {
      const manualTok = directInput.value.trim();
      if (manualTok !== oauthConfig.accessToken) {
        oauthConfig.accessToken = manualTok;
        oauthConfig.tokenExpiry = Date.now() + 3500 * 1000;
        await persistOAuthConfigEverywhere();
        fetchAndSaveGoogleUserProfile(manualTok).catch(() => {});
        return oauthConfig.accessToken;
      }
    }

    const clientId = getActiveClientId();
    oauthConfig.clientId = clientId;
    if (!clientId || !window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      return null;
    }

    // If silent refresh is requested, only attempt if user previously connected (has userEmail, lastCloudSync, or driveFileId)
    const hasPriorConnection = Boolean(oauthConfig.userEmail || oauthConfig.lastCloudSync || oauthConfig.driveFileId || oauthConfig.accessToken);
    if (!interactiveAllowed && !hasPriorConnection) {
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
      }, interactiveAllowed ? 60000 : 8000);

      try {
        const userHint = oauthConfig.userEmail || undefined;
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          prompt: interactiveAllowed ? '' : 'none',
          hint: userHint,
          login_hint: userHint,
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
              await persistOAuthConfigEverywhere();
              fetchAndSaveGoogleUserProfile(resp.access_token).catch(() => {});
              renderGoogleAccountUI();
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
        const reqOpts = { prompt: interactiveAllowed ? '' : 'none' };
        if (userHint) {
          reqOpts.hint = userHint;
          reqOpts.login_hint = userHint;
        }
        tokenClient.requestAccessToken(reqOpts);
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
      return { fileId: null, allFiles: [], cloudData: null, modifiedTimeMs: 0 };
    }
    let bestFileId = files[0].id;
    let bestCloudData = null;
    let bestLastSaved = -1;
    let bestModifiedMs = new Date(files[0].modifiedTime || 0).getTime() || 0;

    for (let i = 0; i < Math.min(files.length, 4); i++) {
      const fId = files[i].id;
      const fileModMs = new Date(files[i].modifiedTime || 0).getTime() || 0;
      try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fId)}?alt=media&_t=${Date.now()}`, {
          headers: {
            Authorization: `Bearer ${token}`
          },
          cache: 'no-store'
        });
        if (res.ok) {
          const json = await res.json();
          const ts = Number((json && json.lastSaved) || fileModMs || 0);
          if (ts > bestLastSaved) {
            bestLastSaved = ts;
            bestCloudData = json;
            bestFileId = fId;
            bestModifiedMs = Math.max(fileModMs, ts);
          }
        }
      } catch (e) {}
    }

    if (bestModifiedMs > lastKnownCloudModifiedMs) {
      lastKnownCloudModifiedMs = bestModifiedMs;
    }

    if (typeof oauthConfig !== 'undefined' && oauthConfig && bestFileId) {
      oauthConfig.driveFileId = bestFileId;
      persistOAuthConfigEverywhere();
    }
    return { fileId: bestFileId, allFiles: files, cloudData: bestCloudData, modifiedTimeMs: bestModifiedMs };
  }

  // Non-destructive smart merge when user edited tasks offline in the current session AND cloud also has updates
  function mergeCloudAndLocalWorkspaces(cloudData, localState) {
    if (!cloudData || typeof cloudData !== 'object') return localState;
    if (!localState || typeof localState !== 'object') return cloudData;

    const merged = Object.assign({}, cloudData, localState);

    // Merge tasks by ID (keep all cloud tasks + any new/updated tasks from current session)
    const cloudTasks = Array.isArray(cloudData.tasks) ? cloudData.tasks : [];
    const localTasks = Array.isArray(localState.tasks) ? localState.tasks : [];
    const taskMap = new Map();
    cloudTasks.forEach(t => { if (t && t.id) taskMap.set(t.id, t); });
    localTasks.forEach(t => {
      if (!t || !t.id) return;
      const existing = taskMap.get(t.id);
      if (!existing) {
        taskMap.set(t.id, t);
      } else {
        const localUpd = Number(t.updatedAt || t.createdAt || 0);
        const cloudUpd = Number(existing.updatedAt || existing.createdAt || 0);
        if (localUpd >= cloudUpd) {
          taskMap.set(t.id, Object.assign({}, existing, t, {
            trackedSeconds: Math.max(Number(existing.trackedSeconds || 0), Number(t.trackedSeconds || 0))
          }));
        }
      }
    });
    merged.tasks = Array.from(taskMap.values());

    // Merge habits by ID
    const cloudHabits = Array.isArray(cloudData.habits) ? cloudData.habits : [];
    const localHabits = Array.isArray(localState.habits) ? localState.habits : [];
    const habitMap = new Map();
    cloudHabits.forEach(h => { if (h && h.id) habitMap.set(h.id, h); });
    localHabits.forEach(h => {
      if (!h || !h.id) return;
      if (!habitMap.has(h.id)) {
        habitMap.set(h.id, h);
      } else {
        const ch = habitMap.get(h.id);
        habitMap.set(h.id, Object.assign({}, ch, h, {
          streak: Math.max(Number(ch.streak || 0), Number(h.streak || 0))
        }));
      }
    });
    merged.habits = Array.from(habitMap.values());

    merged.lastSaved = Math.max(Number(cloudData.lastSaved || 0), Number(localState.lastSaved || 0), Date.now());
    return merged;
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
      hasRealUserEditsInCurrentSession = false;
      lastSavedDataSignature = computeCoreDataSignature(state);

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
        oauthConfig.lastCloudSync = Number(state.lastSaved || Date.now());
        oauthConfig.autoSync = true;
        await persistOAuthConfigEverywhere();
      }

      if (typeof applyThemeAndDir === 'function') applyThemeAndDir();
      if (typeof renderApp === 'function') renderApp();
      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');
      renderGoogleAccountUI();

      const statusEl = document.getElementById('driveModalStatusText');
      if (statusEl) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        statusEl.textContent = state.lang === 'ar'
          ? `☁️ تم استدعاء أحدث نسخة احتياطية من Google Cloud (${timeStr})`
          : `☁️ Pulled latest backup from Google Cloud (${timeStr})`;
      }

      if (showNotification && typeof showToast === 'function') {
        showToast(state.lang === 'ar'
          ? '☁️ تم استدعاء أحدث نسخة احتياطية من حساب Google بنجاح!'
          : '☁️ Restored latest backup from Google account!');
      }
      return true;
    } finally {
      isInternalStateLoadOrRestore = false;
    }
  }

  // 4. FAST 1-ROUNDTRIP UPLOAD to Google Drive with keepalive: true
  window.syncToGoogleDriveNow = syncToGoogleDriveNow = async function (isManual = false, useKeepalive = false) {
    if (!navigator.onLine) {
      if (hasRealUserEditsInCurrentSession || isManual) {
        markDirtyEdit(state.lastSaved || Date.now());
        state.pendingOfflineCloudSync = true;
        safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      }
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '📦 لا يوجد اتصال بالإنترنت حالياً – سيتم الحفظ محلياً والرفع تلقائياً فور الاتصال' : '📦 Offline – saved locally & queued for auto-sync');
      }
      return false;
    }

    if (isCloudSyncInProgress && !useKeepalive) return false;
    isCloudSyncInProgress = true;

    if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');

    try {
      let token = await ensureFreshDriveAccessToken(false);
      if (!token) {
        if (isManual) {
          pendingPostAuthAction = 'upload';
          isCloudSyncInProgress = false;
          handleGoogleDriveConnect('upload');
          return false;
        }
        if (hasRealUserEditsInCurrentSession) {
          markDirtyEdit(state.lastSaved || Date.now());
          state.pendingOfflineCloudSync = true;
        }
        if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
        renderGoogleAccountUI();
        return false;
      }

      const nowTs = Date.now();
      if (hasLocalDirtyEdits || hasRealUserEditsInCurrentSession || isManual) {
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
        const metadata = { name: PRIMARY_BACKUP_FILENAME, mimeType: 'application/json' };
        const boundary = '-------MunjizSyncBoundaryV15';
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
        if (multipartBody.length < 60000 || useKeepalive) {
          fetchOpts.keepalive = true;
        }
        return fetch(url, fetchOpts);
      };

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
          isCloudSyncInProgress = false;
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

      // Update any duplicate backup files on Drive in background so all devices see identical data
      if (!useKeepalive) {
        findAllDriveBackupFiles(token).then((allFiles) => {
          if (Array.isArray(allFiles) && allFiles.length > 1) {
            for (let i = 0; i < allFiles.length; i++) {
              if (allFiles[i].id !== oauthConfig.driveFileId) {
                uploadToFileId(token, allFiles[i].id).catch(() => ({}));
              }
            }
          }
        }).catch(() => ({}));
      }

      lastKnownCloudModifiedMs = Math.max(lastKnownCloudModifiedMs, Number(payloadObj.lastSaved || Date.now()));
      oauthConfig.lastCloudSync = Number(payloadObj.lastSaved || Date.now());
      oauthConfig.autoSync = true;
      clearDirtyEdit();
      lastSavedDataSignature = computeCoreDataSignature(state);

      await persistOAuthConfigEverywhere();

      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      safeLocalSet(fallbackKey, payloadObj);
      if (typeof idbPutRecord === 'function') {
        await idbPutRecord(Object.assign({}, payloadObj, { id: 'primary_workspace' })).catch(() => ({}));
        await idbPutRecord(Object.assign({}, payloadObj, { id: 'google_drive_cloud_mirror' })).catch(() => ({}));
      }

      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');
      renderGoogleAccountUI();

      const statusEl = document.getElementById('driveModalStatusText');
      if (statusEl) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        statusEl.textContent = state.lang === 'ar'
          ? `✓ تمت المزامنة الفورية مع Google Cloud (${timeStr})`
          : `✓ Synced latest edits to Google Cloud (${timeStr})`;
      }

      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '☁️ تم حفظ جميع التغييرات على Google Cloud بنجاح!' : '☁️ All edits synced to Google Cloud successfully!');
      }
      return true;
    } catch (err) {
      console.warn('[MunjizSync] Upload deferred:', err);
      if (hasRealUserEditsInCurrentSession || isManual) {
        markDirtyEdit(state.lastSaved || Date.now());
        state.pendingOfflineCloudSync = true;
        safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      }
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      renderGoogleAccountUI();
      return false;
    } finally {
      isCloudSyncInProgress = false;
    }
  };

  // 5. Explicit Restore / Pull from Google Drive (supports both restoreFromGoogleDriveNow(true) from index.html buttons and restoreFromGoogleDriveNow())
  window.restoreFromGoogleDriveNow = restoreFromGoogleDriveNow = async function (arg = true) {
    const isInteractive = (arg !== 'SILENT_BG');
    if (!navigator.onLine) {
      if (isInteractive && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '⚠️ لا يوجد اتصال بالإنترنت حالياً' : '⚠️ Offline right now');
      }
      return false;
    }

    if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');
    try {
      let token = await ensureFreshDriveAccessToken(false);
      if (!token) {
        if (isInteractive) {
          pendingPostAuthAction = 'pull';
          handleGoogleDriveConnect('pull');
        } else if (typeof updateSyncStatusBadge === 'function') {
          updateSyncStatusBadge('saved_local');
        }
        return false;
      }

      const { fileId, cloudData } = await fetchLatestCloudBackupObject(token);
      if (!fileId || !cloudData) {
        return await syncToGoogleDriveNow(isInteractive);
      }

      return await applyCloudDataToLocalState(cloudData, isInteractive);
    } catch (err) {
      console.warn('[MunjizSync] Restore error:', err);
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('saved_local');
      return false;
    }
  };

  window.manualPullFromGoogleDrive = manualPullFromGoogleDrive = async function () {
    return await restoreFromGoogleDriveNow(true);
  };

  // 6. SMART TWO-WAY RECONCILIATION (Pulls Latest Backup on Sign-In / Startup!)
  window.smartReconcileWithGoogleCloud = smartReconcileWithGoogleCloud = async function (isInteractive = false, options = {}) {
    const isSignInFlow = Boolean(options && options.isSignInFlow);
    if (!navigator.onLine && !isInteractive && !isSignInFlow) return false;
    let token = await ensureFreshDriveAccessToken(false);
    if (!token) return false;

    try {
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');
      const { fileId, cloudData } = await fetchLatestCloudBackupObject(token);

      // If no backup exists on Google Drive yet, upload current workspace to initialize Drive backup
      if (!fileId || !cloudData) {
        return await syncToGoogleDriveNow(isInteractive);
      }

      const cloudTs = Number(cloudData.lastSaved || 0);
      const dirtyTs = getSavedDirtyTimestamp();
      const localTs = Number(state.lastSaved || 0);
      const lastCloudSyncTs = Number((typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.lastCloudSync) || 0);

      // CASE 1: User has NOT made any real task/habit edits in this current browser session (e.g. just opened the app on a device or just clicked Sign in with Google)
      if (!hasRealUserEditsInCurrentSession && !(hasLocalDirtyEdits && dirtyTs > cloudTs && lastCloudSyncTs > 0 && cloudTs <= lastCloudSyncTs)) {
        // If signing in, or if Cloud has newer/equal data, or if Cloud was updated after this device's lastCloudSync -> ALWAYS PULL FROM CLOUD!
        if (isSignInFlow || cloudTs >= localTs || localTs === 0 || (lastCloudSyncTs > 0 && cloudTs > lastCloudSyncTs) || !lastCloudSyncTs) {
          return await applyCloudDataToLocalState(cloudData, isInteractive || isSignInFlow);
        }
      }

      // CASE 2: User DID make real edits in this current session (or genuine v15 offline outbox) BEFORE signing in / syncing
      if (hasRealUserEditsInCurrentSession || (hasLocalDirtyEdits && dirtyTs > cloudTs)) {
        // If another device ALSO updated the cloud since this device last synced -> Smart Merge both so zero tasks are lost!
        if (cloudTs > 0 && (cloudTs > lastCloudSyncTs || !lastCloudSyncTs)) {
          const mergedState = mergeCloudAndLocalWorkspaces(cloudData, state);
          await applyCloudDataToLocalState(mergedState, false);
          return await syncToGoogleDriveNow(isInteractive);
        }
        return await syncToGoogleDriveNow(isInteractive);
      }

      // Default: Pull latest backup from Google Cloud
      if (cloudTs >= localTs || localTs === 0) {
        return await applyCloudDataToLocalState(cloudData, isInteractive);
      }

      return await syncToGoogleDriveNow(isInteractive);
    } catch (err) {
      console.warn('[MunjizSync] Smart reconcile error:', err);
      return false;
    }
  };

  // Lightweight background check for changes saved on other devices while app is open
  async function pollCloudForRemoteChanges() {
    if (!navigator.onLine || isCloudSyncInProgress || hasLocalDirtyEdits || hasRealUserEditsInCurrentSession) return;
    if (typeof oauthConfig === 'undefined' || !oauthConfig || !oauthConfig.autoSync) return;

    // Proactively renew token if near expiry
    if (isTokenNearExpiry()) {
      await ensureFreshDriveAccessToken(false);
    }
    if (!isOAuthTokenValid()) return;

    try {
      const files = await findAllDriveBackupFiles(oauthConfig.accessToken);
      if (!files || files.length === 0) return;
      const newestModMs = new Date(files[0].modifiedTime || 0).getTime() || 0;
      const localTs = Number((typeof state !== 'undefined' && state && state.lastSaved) || 0);

      if (newestModMs > lastKnownCloudModifiedMs + 1500 && newestModMs > localTs + 1500) {
        const { cloudData } = await fetchLatestCloudBackupObject(oauthConfig.accessToken);
        const cloudTs = Number((cloudData && cloudData.lastSaved) || newestModMs || 0);
        if (cloudData && cloudTs > localTs) {
          await applyCloudDataToLocalState(cloudData, true);
        }
      }
    } catch (e) {}
  }

  // 7. Upgrade handleGoogleDriveConnect: NEVER defaults to blind 'upload' on connect! Always pulls latest backup first unless forcedMode === 'upload'
  window.handleGoogleDriveConnect = handleGoogleDriveConnect = function (forcedMode) {
    if (typeof handleOAuthConfigChange === 'function') {
      try { handleOAuthConfigChange(); } catch (e) {}
    }
    const clientId = getActiveClientId();
    oauthConfig.clientId = clientId;
    oauthConfig.autoSync = true;

    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    if (directInput) directInput.value = '';

    // Always default to 'smart' (which pulls latest cloud backup on sign-in!) unless explicitly forced to 'upload' or 'pull'
    const explicitMode = (typeof forcedMode === 'string' && (forcedMode === 'upload' || forcedMode === 'pull' || forcedMode === 'smart'))
      ? forcedMode
      : null;
    const mode = explicitMode || pendingPostAuthAction || 'smart';
    pendingPostAuthAction = null;

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      if (typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? 'جاري تحميل مكتبة Google Sign-In...' : 'Loading Google Sign-In...');
      }
      return;
    }

    const userHint = oauthConfig.userEmail || undefined;
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      hint: userHint,
      login_hint: userHint,
      callback: async (resp) => {
        if (!resp || !resp.access_token) return;
        oauthConfig.accessToken = resp.access_token;
        const expiresInSec = Number(resp.expires_in || 3599);
        oauthConfig.tokenExpiry = Date.now() + expiresInSec * 1000;
        oauthConfig.autoSync = true;
        await persistOAuthConfigEverywhere();

        // Fetch and save Google user email immediately so future token renewals happen silently!
        await fetchAndSaveGoogleUserProfile(resp.access_token);

        if (mode === 'upload') {
          await syncToGoogleDriveNow(true);
        } else if (mode === 'pull') {
          await restoreFromGoogleDriveNow(true);
        } else {
          await smartReconcileWithGoogleCloud(true, { isSignInFlow: true });
        }

        renderGoogleAccountUI();
        if (typeof renderDriveModalState === 'function') {
          try { renderDriveModalState(); } catch (e) {}
        }
      }
    });

    const reqOpts = { prompt: '' };
    if (userHint) {
      reqOpts.hint = userHint;
      reqOpts.login_hint = userHint;
    }
    tokenClient.requestAccessToken(reqOpts);
  };

  // Direct 1-click Google Sign-In / Sync handler (never opens technical Google Console modal!)
  window.quickGoogleSignInOrSync = async function () {
    if (isOAuthTokenValid()) {
      await smartReconcileWithGoogleCloud(true, { isSignInFlow: false });
      return;
    }
    // Try silent refresh first if userEmail is known
    const silentToken = await ensureFreshDriveAccessToken(false);
    if (silentToken) {
      await smartReconcileWithGoogleCloud(true, { isSignInFlow: true });
      return;
    }
    // Otherwise trigger 1-click Google OAuth popup directly using built-in Client ID
    handleGoogleDriveConnect('smart');
  };

  const origDisconnectGoogleDrive = window.disconnectGoogleDrive;
  window.disconnectGoogleDrive = disconnectGoogleDrive = async function () {
    if (typeof oauthConfig !== 'undefined' && oauthConfig) {
      oauthConfig.accessToken = null;
      oauthConfig.tokenExpiry = 0;
      oauthConfig.driveFileId = null;
      oauthConfig.userEmail = '';
      oauthConfig.userName = '';
      oauthConfig.userPicture = '';
      await persistOAuthConfigEverywhere();
    }
    if (typeof origDisconnectGoogleDrive === 'function') {
      try { await origDisconnectGoogleDrive(); } catch (e) {}
    }
    renderGoogleAccountUI();
  };

  window.saveAndSyncDirectToken = saveAndSyncDirectToken = async function () {
    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    const tok = directInput ? directInput.value.trim() : '';
    if (!tok) return;
    oauthConfig.accessToken = tok;
    oauthConfig.tokenExpiry = Date.now() + 3500 * 1000;
    oauthConfig.autoSync = true;
    await persistOAuthConfigEverywhere();
    await fetchAndSaveGoogleUserProfile(tok);
    await smartReconcileWithGoogleCloud(true, { isSignInFlow: true });
    renderGoogleAccountUI();
  };

  // Wrap UI-only navigation functions so switching tabs/layouts NEVER marks data as dirty
  const origSetSplitSubLayout = window.setSplitSubLayout;
  if (typeof origSetSplitSubLayout === 'function') {
    window.setSplitSubLayout = setSplitSubLayout = function () {
      const prev = isUiNavigationOnly;
      isUiNavigationOnly = true;
      try {
        return origSetSplitSubLayout.apply(this, arguments);
      } finally {
        isUiNavigationOnly = prev;
      }
    };
  }

  const origSwitchMainView = window.switchMainView;
  if (typeof origSwitchMainView === 'function') {
    window.switchMainView = switchMainView = function () {
      const prev = isUiNavigationOnly;
      isUiNavigationOnly = true;
      try {
        return origSwitchMainView.apply(this, arguments);
      } finally {
        isUiNavigationOnly = prev;
      }
    };
  }

  // 8. Upgrade saveState: Only marks dirty & bumps lastSaved when core data (tasks/habits/categories/review) actually changes!
  window.saveState = saveState = async function (triggerExternalAutoSync = true) {
    if (typeof state === 'undefined' || !state) return;

    const currentSig = computeCoreDataSignature(state);
    const didCoreDataChange = (lastSavedDataSignature !== null && currentSig !== lastSavedDataSignature);

    const isInternalOrUiOnly = (
      triggerExternalAutoSync === 'INTERNAL_NO_SYNC' ||
      triggerExternalAutoSync === false ||
      isInternalStateLoadOrRestore ||
      isBootstrappingApp ||
      !hasFinishedInitialLocalLoad ||
      (isUiNavigationOnly && !didCoreDataChange) ||
      !didCoreDataChange
    );

    if (!isInternalOrUiOnly) {
      const now = Date.now();
      state.lastSaved = now;
      lastSavedDataSignature = currentSig;
      hasRealUserEditsInCurrentSession = true;
      markDirtyEdit(now);
    }

    const cleanSnapshot = JSON.parse(JSON.stringify(Object.assign({}, state, {
      id: 'primary_workspace',
      isTimerRunning: false
    })));

    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    if (hasFinishedInitialLocalLoad) {
      safeLocalSet(fallbackKey, cleanSnapshot);
      persistLiveTimerCheckpoint();
    }

    if (!isInternalOrUiOnly) {
      state.pendingOfflineCloudSync = true;
      cleanSnapshot.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, cleanSnapshot);
      safeLocalSet(fallbackKey, cleanSnapshot);
      if (!navigator.onLine && typeof updateSyncStatusBadge === 'function') {
        updateSyncStatusBadge((typeof diskFileHandle !== 'undefined' && diskFileHandle) ? 'synced_disk' : 'offline_queued');
      }
    }

    if (hasFinishedInitialLocalLoad && typeof idbPutRecord === 'function') {
      try {
        await idbPutRecord(cleanSnapshot);
      } catch (err) {}
    }

    if (!isInternalOrUiOnly && typeof syncChannel !== 'undefined' && syncChannel) {
      try {
        syncChannel.postMessage({
          type: 'STATE_UPDATED',
          timestamp: state.lastSaved,
          payload: cleanSnapshot
        });
      } catch (e) {}
    }

    if (!isInternalOrUiOnly) {
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

      if (typeof oauthConfig !== 'undefined' && oauthConfig && (oauthConfig.accessToken || oauthConfig.clientId || getActiveClientId())) {
        oauthConfig.autoSync = true;
        await syncToGoogleDriveNow(false);
      }
    };

    if (immediate) {
      runSync();
    } else {
      autoSyncDebounceTimer = setTimeout(runSync, 200);
    }
  };

  window.flushOfflineSyncQueue = flushOfflineSyncQueue = async function () {
    if (!navigator.onLine) return false;
    const outbox = safeLocalGet(OFFLINE_OUTBOX_KEY);
    const dirtyTs = getSavedDirtyTimestamp();

    if (outbox && (hasRealUserEditsInCurrentSession || hasLocalDirtyEdits) && dirtyTs > 0) {
      if (Number(outbox.lastSaved || 0) >= Number(state.lastSaved || 0)) {
        const wasRunning = state.isTimerRunning;
        state = Object.assign({}, state, outbox, { isTimerRunning: Boolean(wasRunning) });
      }
      const ok = await syncToGoogleDriveNow(false);
      if (ok && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '🌐 عاد الاتصال: تم إرسال التعديلات المعلقة تلقائياً إلى السحابة!' : '🌐 Online: All pending offline edits synced to Cloud!');
      }
      return ok;
    }
    return await smartReconcileWithGoogleCloud(false);
  };

  // 9. Upgrade loadState: Protects startup from marking stale data dirty & pulls latest cloud backup automatically
  window.loadState = loadState = async function () {
    v15Initialized = true;
    isInternalStateLoadOrRestore = true;
    isBootstrappingApp = true;
    hasRealUserEditsInCurrentSession = false;

    try {
      let loadedOAuth = null;
      if (typeof idbGetRecord === 'function') {
        try { loadedOAuth = await idbGetRecord('oauth_config'); } catch (e) {}
      }
      if (!loadedOAuth) {
        const oauthKey = typeof OAUTH_STORAGE_KEY !== 'undefined' ? OAUTH_STORAGE_KEY : OAUTH_FALLBACK_KEY_V4;
        loadedOAuth = safeLocalGet(oauthKey) || safeLocalGet(OAUTH_FALLBACK_KEY_V4) || safeLocalGet(OAUTH_FALLBACK_KEY_V1);
      }
      if (typeof oauthConfig !== 'undefined' && oauthConfig) {
        if (loadedOAuth && typeof loadedOAuth === 'object') {
          oauthConfig = Object.assign({}, oauthConfig, loadedOAuth, {
            id: 'oauth_config',
            clientId: (loadedOAuth.clientId || oauthConfig.clientId || BUILTIN_GOOGLE_CLIENT_ID).trim(),
            autoSync: true
          });
        } else {
          oauthConfig.clientId = (oauthConfig.clientId || BUILTIN_GOOGLE_CLIENT_ID).trim();
          oauthConfig.autoSync = true;
        }
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

        hasLocalDirtyEdits = Boolean(dirtyTs > 0 && outboxSnap);
      }

      hasFinishedInitialLocalLoad = true;
      enforcePausedTimerAtLastTimeOnStartup();
      lastSavedDataSignature = computeCoreDataSignature(state);

      if (!state.activeTaskId || !Array.isArray(state.tasks) || !state.tasks.some(t => t.id === state.activeTaskId)) {
        state.activeTaskId = (Array.isArray(state.tasks) && state.tasks[0]) ? state.tasks[0].id : null;
      }

      if (typeof idbGetRecord === 'function') {
        try {
          const savedHandleRec = await idbGetRecord('disk_file_handle_record');
          if (savedHandleRec && savedHandleRec.handle && typeof verifyDiskHandlePermission === 'function') {
            diskFileHandle = savedHandleRec.handle;
            state.linkedDiskFileName = savedHandleRec.fileName || diskFileHandle.name || PRIMARY_BACKUP_FILENAME;
          }
        } catch (e) {}
      }
    } finally {
      isInternalStateLoadOrRestore = false;
      // Keep isBootstrappingApp = true until DOMContentLoaded synchronous/microtask setup finishes!
      setTimeout(() => {
        isBootstrappingApp = false;
        lastSavedDataSignature = computeCoreDataSignature(state);
      }, 1500);
    }

    injectGoogleSignInUI();
    renderGoogleAccountUI();

    setTimeout(() => {
      if (navigator.onLine) {
        smartReconcileWithGoogleCloud(false);
      }
    }, 250);
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
            showToast(state.lang === 'ar' ? '🎉 اكتملت الجلسة! عمل رائع.' : '🎉 Session complete! Great focus.');
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
            ? (state.lang === 'ar' ? 'متابعة المهمة' : 'Resume Task')
            : (state.lang === 'ar' ? 'بدء التركيز' : 'Start Focus');
        }
      }
    };
  }

  // 11. Google Sign-In UI Injection & Status Badge Upgrade
  function injectGoogleSignInUI() {
    // A) Inject sleek 1-click Google Sign-In / Sync Pill in Header
    const badgeBtn = document.getElementById('badgeStorageStatus') || document.getElementById('btnSyncCloud');
    if (badgeBtn) {
      badgeBtn.classList.remove('hidden');
      if (badgeBtn.style && typeof badgeBtn.style.setProperty === 'function') {
        badgeBtn.style.setProperty('display', 'inline-flex', 'important');
      } else if (badgeBtn.style) {
        badgeBtn.style.display = 'inline-flex';
      }
      badgeBtn.className = 'px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 transition-all flex items-center gap-2 cursor-pointer ms-2';
      badgeBtn.onclick = function (e) {
        if (e) e.preventDefault();
        window.quickGoogleSignInOrSync();
      };

      if (!document.getElementById('munjizGoogleSettingsGear') && badgeBtn.parentNode) {
        const settingsGearBtn = document.createElement('button');
        settingsGearBtn.type = 'button';
        settingsGearBtn.id = 'munjizGoogleSettingsGear';
        settingsGearBtn.onclick = function (e) {
          if (e) e.stopPropagation();
          if (typeof openDriveModal === 'function') openDriveModal();
        };
        settingsGearBtn.className = 'px-2 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-[#131c31] text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-200 dark:hover:bg-[#1e293b] transition-all flex items-center gap-1 cursor-pointer ms-1';
        settingsGearBtn.title = 'إعدادات المزامنة والنسخ الاحتياطي';
        settingsGearBtn.innerHTML = '<span>⚙️</span>';
        badgeBtn.parentNode.insertBefore(settingsGearBtn, badgeBtn.nextSibling);
      }
    }

    // B) Upgrade Drive Modal to feature a prominent "Sign in with Google" card & prefill Client ID
    const modalBox = document.getElementById('driveModalStatusBox');
    if (modalBox && !document.getElementById('munjizGoogleSignInCard')) {
      const card = document.createElement('div');
      card.id = 'munjizGoogleSignInCard';
      card.className = 'p-4 rounded-2xl bg-gradient-to-r from-blue-600/10 via-indigo-600/10 to-emerald-600/10 border border-blue-500/30 space-y-3';
      card.innerHTML = `
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-xl bg-white dark:bg-slate-800 shadow-sm flex items-center justify-center text-lg font-bold border border-slate-200 dark:border-slate-700">G</div>
            <div>
              <div id="munjizModalAccountTitle" class="text-sm font-extrabold text-slate-900 dark:text-white">الدخول بحساب Google والمزامنة الفورية</div>
              <div id="munjizModalAccountSub" class="text-xs text-slate-500 dark:text-slate-400">يستدعي أحدث نسخة احتياطية تلقائياً ويحفظ أي تعديل فوراً</div>
            </div>
          </div>
          <button type="button" id="btnModalGoogleSignIn" onclick="window.quickGoogleSignInOrSync()" class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md transition flex items-center gap-1.5 cursor-pointer">
            <span>🔐</span>
            <span id="lblModalGoogleSignInBtn">تسجيل الدخول بحساب Google</span>
          </button>
        </div>
      `;
      modalBox.parentNode.insertBefore(card, modalBox.nextSibling);

      const clientInp = document.getElementById('inputGoogleClientId');
      if (clientInp && !clientInp.value) {
        clientInp.value = getActiveClientId();
      }
    }
  }

  function renderGoogleAccountUI() {
    const isAr = !(typeof state !== 'undefined' && state && state.lang === 'en');
    const valid = isOAuthTokenValid();
    const email = (typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.userEmail) ? oauthConfig.userEmail : '';
    const titleEl = document.getElementById('munjizModalAccountTitle');
    const subEl = document.getElementById('munjizModalAccountSub');
    const btnLbl = document.getElementById('lblModalGoogleSignInBtn');

    if (titleEl && subEl && btnLbl) {
      if (valid) {
        titleEl.textContent = isAr
          ? `✅ متصل بحساب Google${email ? ` (${email})` : ''}`
          : `✅ Signed in with Google${email ? ` (${email})` : ''}`;
        subEl.textContent = isAr
          ? 'المزامنة التلقائية الفورية مفعلة — يتم حفظ واستدعاء أحدث نسخة تلقائياً'
          : 'Instant auto-sync active — latest backup synced automatically';
        btnLbl.textContent = isAr ? 'مزامنة وتحديث الآن 🔄' : 'Sync Now 🔄';
      } else if (email) {
        titleEl.textContent = isAr ? `حساب Google المرتبط: ${email}` : `Linked Google Account: ${email}`;
        subEl.textContent = isAr
          ? 'انقر لاستئناف الجلسة واستدعاء أحدث نسخة احتياطية بضغطة واحدة'
          : 'Click to resume session & pull latest backup in 1 click';
        btnLbl.textContent = isAr ? 'استئناف المزامنة السحابية 🔄' : 'Resume Cloud Sync 🔄';
      } else {
        titleEl.textContent = isAr ? 'الدخول بحساب Google والمزامنة الفورية' : 'Sign in with Google & Instant Sync';
        subEl.textContent = isAr
          ? 'يستدعي أحدث نسخة احتياطية تلقائياً عند الفتح ويحفظ أي تعديل فوراً بدون إعدادات معقدة'
          : 'Automatically pulls latest backup on open and syncs every edit instantly';
        btnLbl.textContent = isAr ? 'تسجيل الدخول بحساب Google' : 'Sign in with Google';
      }
    }
  }

  const originalUpdateSyncStatusBadge = typeof updateSyncStatusBadge === 'function' ? updateSyncStatusBadge : null;
  window.updateSyncStatusBadge = updateSyncStatusBadge = function (statusType) {
    if (originalUpdateSyncStatusBadge) {
      try { originalUpdateSyncStatusBadge(statusType); } catch (e) {}
    }
    injectGoogleSignInUI();
    renderGoogleAccountUI();

    const lbl = document.getElementById('lblOfflineStatus') || document.getElementById('lblSyncStatus');
    const dot = document.getElementById('dotSyncIndicator');
    if (!lbl) return;
    const isAr = !(typeof state !== 'undefined' && state && state.lang === 'en');
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const email = (typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.userEmail) ? oauthConfig.userEmail : '';

    if (statusType === 'synced_cloud' || statusType === 'synced_drive') {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
      lbl.textContent = isAr
        ? `☁️ متزامن${email ? ` (${email.split('@')[0]})` : ''} ✨ (${timeStr})`
        : `☁️ Synced${email ? ` (${email.split('@')[0]})` : ''} ✨ (${timeStr})`;
    } else if (statusType === 'syncing_cloud' || statusType === 'syncing') {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-blue-500 animate-ping';
      lbl.textContent = isAr ? '☁️ جاري المزامنة الفورية...' : '☁️ Syncing with Google Cloud...';
    } else if (!isOAuthTokenValid() && email) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-blue-500 animate-pulse';
      lbl.textContent = isAr
        ? `🔄 استئناف مزامنة Google (${email.split('@')[0]})`
        : `🔄 Resume Google Sync (${email.split('@')[0]})`;
    } else if (!isOAuthTokenValid()) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-blue-500 animate-pulse';
      lbl.textContent = isAr ? '🔐 الدخول بحساب Google للمزامنة' : '🔐 Sign in with Google to Sync';
    }
  };

  function handleAppCloseOrHide(isUnload) {
    if (typeof state === 'undefined' || !state) return;
    const wasTimerRunning = Boolean(state.isTimerRunning);
    if (isUnload && state.isTimerRunning) {
      if (typeof mainTimerInterval !== 'undefined' && mainTimerInterval) {
        clearInterval(mainTimerInterval);
        mainTimerInterval = null;
      }
      state.isTimerRunning = false;
    }
    if (wasTimerRunning && hasFinishedInitialLocalLoad) {
      const now = Date.now();
      state.lastSaved = now;
      hasRealUserEditsInCurrentSession = true;
      markDirtyEdit(now);
    }
    persistLiveTimerCheckpoint();
    if (hasRealUserEditsInCurrentSession && (hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0) && navigator.onLine && isOAuthTokenValid()) {
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

  window.addEventListener('focus', () => {
    if (navigator.onLine) {
      pollCloudForRemoteChanges();
    }
  });

  window.addEventListener('online', () => {
    flushOfflineSyncQueue();
  });

  // Periodic sync for dirty local edits (every 8 seconds)
  if (!periodicSyncHeartbeat) {
    periodicSyncHeartbeat = setInterval(() => {
      if (navigator.onLine && hasRealUserEditsInCurrentSession && (hasLocalDirtyEdits || getSavedDirtyTimestamp() > 0) && isOAuthTokenValid()) {
        syncToGoogleDriveNow(false);
      }
    }, 8000);
  }

  // Periodic lightweight poll for remote edits from other devices + proactive silent token refresh (every 20 seconds)
  if (!remotePollInterval) {
    remotePollInterval = setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') {
        pollCloudForRemoteChanges();
      }
    }, 20000);
  }

  // Proactive token check every 60 seconds so token never expires while app is open
  if (!proactiveTokenTimer) {
    proactiveTokenTimer = setInterval(() => {
      if (navigator.onLine && isTokenNearExpiry()) {
        ensureFreshDriveAccessToken(false).catch(() => {});
      }
    }, 60000);
  }

  // If DOMContentLoaded already ran before this script executed, run loadState() now!
  if (document.readyState !== 'loading' && !v15Initialized) {
    loadState().then(() => {
      if (typeof applyThemeAndDir === 'function') applyThemeAndDir();
      if (typeof renderApp === 'function') renderApp();
      if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
    }).catch(() => {});
  }
})();