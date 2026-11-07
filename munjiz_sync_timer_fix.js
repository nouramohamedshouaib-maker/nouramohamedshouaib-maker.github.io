/* ============================================================================
 * MUNJIZ PLANNER — CLOUD-FIRST SINGLE SOURCE OF TRUTH & TIMER ENGINE (v13.0)
 * Root-Cause Fixes:
 * 1) CLOUD-FIRST ON ANY BROWSER / INCOGNITO:
 *    - Connecting Google Drive (`handleGoogleDriveConnect` / `saveAndSyncDirectToken`)
 *      now ALWAYS PULLS (`restoreFromGoogleDriveNow`) the latest backup from
 *      Google Cloud FIRST instead of uploading the new browser's blank/default state!
 *    - Startup (`loadState`) NEVER stamps `lastSaved = Date.now()` and NEVER
 *      overwrites Google Cloud with local default tasks.
 *    - Every tab focus / startup automatically fetches the latest cloud version
 *      (`orderBy=modifiedTime desc`) from Google Drive.
 * 2) OFFLINE BUFFER ONLY FOR REAL USER EDITS:
 *    - Offline queue only activates when the user explicitly adds/edits/deletes
 *      items while offline, and flushes immediately when back online.
 * 3) TIMER RECOVERY ON SUDDEN CLOSE:
 *    - Checkpoints every second with `isTimerRunning: false` so reopening always
 *      restores the exact last second in PAUSED state with Start/Resume ready.
 * ============================================================================ */
(function () {
  if (window.__MUNJIZ_ROOT_FIX_V13_APPLIED__) return;
  window.__MUNJIZ_ROOT_FIX_V13_APPLIED__ = true;
  window.__MUNJIZ_ROOT_FIX_V12_APPLIED__ = true;

  const LIVE_TIMER_SNAPSHOT_KEY = 'munjiz_live_timer_snapshot_v13';
  const OFFLINE_OUTBOX_KEY = 'munjiz_offline_outbox_v13';
  const BACKUP_FILENAME = typeof DRIVE_BACKUP_FILENAME !== 'undefined' ? DRIVE_BACKUP_FILENAME : 'munjiz_planner_backup.json';
  const LAST_KNOWN_GOOD_BACKUP = {"id": "primary_workspace", "lang": "en", "theme": "light", "textAlignMode": "auto", "ambientPreset": "rain", "zenMode": false, "currentView": "split", "splitSubLayout": "tasks", "tasks": [{"id": "task_1793999674758", "title": "record lesson screen", "titleAr": "record lesson screen", "titleEn": "record lesson screen", "notes": "", "notesAr": "", "notesEn": "", "startTime": "09:00", "endTime": "09:45", "durationMins": 45, "category": "Work", "color": "#2563eb", "quadrant": "q1", "gtdList": "next", "gtdContext": "@computer", "subtasks": [], "trackedSeconds": 0, "completed": false}, {"id": "task_1700000000001", "title": "جلسة عمل عميق: إنهاء المهمة الأساسية لليوم", "titleAr": "جلسة عمل عميق: إنهاء المهمة الأساسية لليوم", "titleEn": "Deep Work Block: Complete Today’s Core Priority", "notes": "تطبيق قاعدة الدقيقتين للبدء فوراً وتجهيز المكتب بدون مشتتات", "notesAr": "تطبيق قاعدة الدقيقتين للبدء فوراً وتجهيز المكتب بدون مشتتات", "notesEn": "Apply the 2-Minute Rule to start immediately in a distraction-free workspace", "startTime": "09:00", "endTime": "10:00", "durationMins": 45, "category": "Work", "color": "#2563eb", "quadrant": "q1", "gtdList": "next", "gtdContext": "@deep-work", "subtasks": [{"id": "st_1", "text": "إغلاق كافة الإشعارات ووضع الهاتف بعيداً", "textAr": "إغلاق كافة الإشعارات ووضع الهاتف بعيداً", "textEn": "Mute all notifications and place phone in another room", "done": true}, {"id": "st_2", "text": "البدء بأول دقيقتين لكسر حاجز التسويف", "textAr": "البدء بأول دقيقتين لكسر حاجز التسويف", "textEn": "Start with the first 2 minutes to beat procrastination", "done": false}, {"id": "st_3", "text": "مراجعة المخرجات النهائية", "textAr": "مراجعة المخرجات النهائية", "textEn": "Review final deliverables", "done": false}], "trackedSeconds": 0, "completed": false}, {"id": "task_1700000000002", "title": "تخطيط الأسبوع ومراجعة الأهداف الاستراتيجية", "titleAr": "تخطيط الأسبوع ومراجعة الأهداف الاستراتيجية", "titleEn": "Weekly Planning & Strategic Goals Review", "notes": "مربع 2 (هام وغير عاجل) لبناء الإنتاجية طويلة المدى", "notesAr": "مربع 2 (هام وغير عاجل) لبناء الإنتاجية طويلة المدى", "notesEn": "Quadrant 2 (Important & Not Urgent) for long-term effectiveness", "startTime": "11:00", "endTime": "11:45", "durationMins": 45, "category": "Personal", "color": "#3b82f6", "quadrant": "q2", "gtdList": "next", "gtdContext": "@computer", "subtasks": [{"id": "st_4", "text": "تصفية صندوق الوارد بالكامل", "textAr": "تصفية صندوق الوارد بالكامل", "textEn": "Clarify GTD Inbox to zero", "done": false}], "trackedSeconds": 0, "completed": false}, {"id": "task_1700000000003", "title": "فكرة: إعداد قالب أتمتة للتقارير الشهرية", "titleAr": "فكرة: إعداد قالب أتمتة للتقارير الشهرية", "titleEn": "Idea: Build automated monthly reporting template", "notes": "تحتاج إلى تصفية في معالج التصفية والتوضيح", "notesAr": "تحتاج إلى تصفية في معالج التصفية والتوضيح", "notesEn": "Needs clarification in the GTD Clarify Wizard", "startTime": "13:00", "endTime": "13:30", "durationMins": 30, "category": "Work", "color": "#0284c7", "quadrant": "q2", "gtdList": "inbox", "gtdContext": "@computer", "subtasks": [], "trackedSeconds": 0, "completed": false}, {"id": "task_1700000000004", "title": "الرد على الرسائل الروتينية وتفويض المهام الفرعية", "titleAr": "الرد على الرسائل الروتينية وتفويض المهام الفرعية", "titleEn": "Reply to routine messages & delegate minor tasks", "notes": "مربع 3 — عاجل وغير هام", "notesAr": "مربع 3 — عاجل وغير هام", "notesEn": "Quadrant 3 — Urgent & Not Important", "startTime": "14:30", "endTime": "15:00", "durationMins": 20, "category": "Work", "color": "#f59e0b", "quadrant": "q3", "gtdList": "waiting", "gtdContext": "@phone", "subtasks": [], "trackedSeconds": 0, "completed": false}], "habits": [{"id": "hab_pos_1", "type": "build", "anchor": "بعد شرب قهوة الصباح أو صلاة العشاء", "anchorEn": "After drinking morning coffee or evening prayer", "title": "قراءة كتاب مفيد وتطوير الذات", "titleEn": "Read an insightful book for self-growth", "identity": "أنا شخص قارئ ومثقف يطور عقله يومياً", "identityEn": "I am a lifelong reader who sharpens my mind daily", "law1Obvious": "وضع الكتاب مفتوحاً على المكتب أو الوسادة صباحاً (الساعة 8 مساءً)", "law1ObviousEn": "Place the book open on my desk/pillow in the morning (for 8:00 PM)", "law2Attractive": "الاستمتاع بمشروبي المفضل فقط أثناء جلسة القراءة", "law2AttractiveEn": "Enjoy my favorite drink exclusively during reading time", "law3Easy": "سأفتح الكتاب وأقرأ صفحة واحدة فقط (دقيقتين)", "law3EasyEn": "Open the book and read just 1 page (2 minutes)", "law4Satisfying": "تعليم اليوم في متتبع السلسلة فوراً كتصويت لهويتي الجديدة", "law4SatisfyingEn": "Check off today in the tracker immediately as a vote for my new identity", "streak": 5, "history": {"0": true, "1": true, "2": true, "3": true, "4": true, "5": false, "6": false}}, {"id": "hab_pos_2", "type": "build", "anchor": "بعد انتهاء الدوام والعودة للمنزل مباشرة", "anchorEn": "Right after finishing work and returning home", "title": "المشي الرياضي وتجديد الطاقة البدنية", "titleEn": "Brisk walking & physical energy renewal", "identity": "أنا شخص رياضي نشيط يهتم بصحته ولياقته", "identityEn": "I am an active, energetic person who prioritizes fitness", "law1Obvious": "تجهيز الحذاء الرياضي وزجاجة الماء بجانب الباب من الليل (الساعة 6 مساءً)", "law1ObviousEn": "Prepare running shoes & water bottle by the door the night before (6:00 PM)", "law2Attractive": "لن أستمع إلى برنامجي الصوتي المفضل إلا وأنا أمشي", "law2AttractiveEn": "Listen to my favorite podcast only while walking", "law3Easy": "ارتداء الحذاء الرياضي والمشي دقيقتين فقط كبداية", "law3EasyEn": "Put on running shoes and walk for just 2 minutes", "law4Satisfying": "متابعة السلسلة اليومية والشعور بالحيوية والإنجاز", "law4SatisfyingEn": "Track the daily streak and celebrate the energy boost", "streak": 3, "history": {"0": true, "1": true, "2": true, "3": false, "4": false, "5": false, "6": false}}, {"id": "hab_neg_1", "type": "break", "title": "التخلص من تضييع الوقت على الهاتف أثناء العمل", "titleEn": "Stop doomscrolling on phone & social media during work", "replacement": "شرب كوب ماء، أخذ 3 أنفاس عميقة، والعمل دقيقتين", "replacementEn": "Drink water, take 3 deep breaths, and work for 2 minutes", "law1Invisible": "أترك الهاتف في غرفة أخرى تماماً أثناء جلسات العمل العميق", "law1InvisibleEn": "Leave the phone in another room during deep work blocks", "law3Difficult": "حذف التطبيقات المشتتة وجعل الدخول يتطلب كتابة كلمة المرور من المتصفح", "law3DifficultEn": "Delete distracting apps and require manual browser password login", "law4Unsatisfying": "أنا شخص متحكم في انتباهي + شريك محاسبة أشاركه تقرير وقت الشاشة", "law4UnsatisfyingEn": "I own my attention + share screen-time report with Accountability Partner", "streak": 4, "urgesResisted": 7, "history": {"0": true, "1": true, "2": true, "3": true, "4": false, "5": false, "6": false}}, {"id": "hab_neg_2", "type": "break", "title": "الإقلاع عن الإسراف في تناول الحلويات والسكريات ليلاً", "titleEn": "Quit late-night sweets and refined sugar cravings", "replacement": "تناول ثمرة فاكهة أو كوب شاي أعشاب دافئ", "replacementEn": "Have a piece of fresh fruit or warm herbal tea", "law1Invisible": "لا أشتري الحلويات ولا أضعها أمام عيني على طاولة المطبخ", "law1InvisibleEn": "Do not buy or leave sweets visible on kitchen counters", "law3Difficult": "عدم الاحتفاظ بأي سكريات جاهزة في غرفة المعيشة أو المكتب", "law3DifficultEn": "Keep zero processed sweets in the living room or office desk", "law4Unsatisfying": "أنا شخص صحي يحترم جسده + التزام مع شريك محاسبة في المنزل", "law4UnsatisfyingEn": "I nourish my body + commitment contract with family partner", "streak": 2, "urgesResisted": 3, "history": {"0": true, "1": true, "2": false, "3": false, "4": false, "5": false, "6": false}}], "categories": [{"id": "Work", "nameEn": "Work", "nameAr": "العمل", "color": "#2563eb"}, {"id": "Study", "nameEn": "Study", "nameAr": "الدراسة", "color": "#0284c7"}, {"id": "Personal", "nameEn": "Personal", "nameAr": "شخصي", "color": "#10b981"}], "weeklyReview": {"steps": [false, false, false, false], "lastCompletedAt": null}, "upcomingAlertEnabled": true, "soundAlertsEnabled": true, "alertLeadMinutes": 15, "notifiedTaskIdsToday": [], "selectedCategoryFilter": "all", "selectedStatusFilter": "all", "selectedGtdTab": "inbox", "selectedGtdContextFilter": "all", "selectedHabitTypeFilter": "all", "habitWizardMode": "build", "activeTaskId": "task_1793999674758", "timerMode": "countdown", "countdownRemainingSec": 2700, "countdownTotalSec": 2700, "isTimerRunning": false, "isTimerFloating": false, "isTimerMinimized": false, "pendingOfflineCloudSync": false, "linkedDiskFileName": null, "lastSaved": 1794000352216, "cleanedDefault780Bug": true};

  let silentRefreshPromise = null;
  let periodicSyncHeartbeat = null;
  let lastTickWallClock = 0;
  let hasPulledFromCloudInSession = false;
  let hasExplicitUserEditInSession = false;
  let isApplyingCloudRestore = false;

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

  // 1. Live Timer Per-Second Checkpoint (always saved with isTimerRunning: false)
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
        isTimerRunning: false
      });
      const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
      safeLocalSet(fallbackKey, diskState);
      if (typeof idbPutRecord === 'function') {
        idbPutRecord(Object.assign({}, diskState, { id: 'primary_workspace' })).catch(() => {});
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

  // 2. Always find the NEWEST backup file on Google Drive (orderBy=modifiedTime desc)
  window.findDriveBackupFileId = findDriveBackupFileId = async function (accessToken) {
    const token = accessToken || (typeof oauthConfig !== 'undefined' ? oauthConfig.accessToken : '');
    if (!token) return null;
    const q = encodeURIComponent(`name = '${BACKUP_FILENAME}' and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&orderBy=modifiedTime%20desc&pageSize=5&fields=files(id,name,modifiedTime,size)`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!res.ok) {
      throw new Error(`Drive search HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data && Array.isArray(data.files) && data.files.length > 0) {
      const chosenId = data.files[0].id;
      if (typeof oauthConfig !== 'undefined' && oauthConfig) {
        oauthConfig.driveFileId = chosenId;
        if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
      }
      return chosenId;
    }
    return null;
  };

  // 3. Silent or Interactive Google OAuth Token Acquisition
  async function ensureFreshDriveAccessToken(interactiveAllowed = false) {
    if (typeof oauthConfig === 'undefined' || !oauthConfig) return null;

    if (oauthConfig.accessToken && Date.now() < (Number(oauthConfig.tokenExpiry || 0) - 60000)) {
      return oauthConfig.accessToken;
    }

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
      }, interactiveAllowed ? 60000 : 6500);

      try {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          prompt: interactiveAllowed ? '' : 'none',
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

  // 4. CLOUD-FIRST PULL: Fetch latest backup from Google Drive and apply immediately
  window.restoreFromGoogleDriveNow = restoreFromGoogleDriveNow = async function (isSilentAutoPull = false) {
    if (!navigator.onLine) {
      if (!isSilentAutoPull && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '⚠️ لا يوجد اتصال بالإنترنت لجلب النسخة السحابية' : '⚠️ Offline — Cannot fetch cloud backup right now');
      }
      return false;
    }

    if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('syncing_cloud');

    try {
      let token = await ensureFreshDriveAccessToken(!isSilentAutoPull);
      if (!token) {
        if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('saved_local');
        return false;
      }

      let fileId = await findDriveBackupFileId(token);
      if (!fileId) {
        // No backup file exists on Drive yet -> upload current state to create it
        hasPulledFromCloudInSession = true;
        await syncToGoogleDriveNow(false);
        return true;
      }

      let res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });

      if (res.status === 401) {
        oauthConfig.accessToken = '';
        oauthConfig.tokenExpiry = 0;
        token = await ensureFreshDriveAccessToken(!isSilentAutoPull);
        if (token) {
          res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store'
          });
        }
      }

      if (!res.ok) {
        throw new Error(`Drive download HTTP ${res.status}`);
      }

      let cloudData = await res.json();

      // Safety recovery: if cloudData was accidentally wiped with empty tasks[] & habits[] during Incognito test,
      // restore from LAST_KNOWN_GOOD_BACKUP so the user's tasks & habits are recovered!
      if (
        cloudData &&
        Array.isArray(cloudData.tasks) && cloudData.tasks.length === 0 &&
        Array.isArray(cloudData.habits) && cloudData.habits.length === 0 &&
        LAST_KNOWN_GOOD_BACKUP &&
        Array.isArray(LAST_KNOWN_GOOD_BACKUP.tasks) && LAST_KNOWN_GOOD_BACKUP.tasks.length > 0
      ) {
        cloudData = Object.assign({}, LAST_KNOWN_GOOD_BACKUP, {
          lastSaved: Date.now()
        });
        // Also push the recovered data back to Drive immediately
        setTimeout(() => {
          hasExplicitUserEditInSession = true;
          syncToGoogleDriveNow(false);
        }, 500);
      }

      if (cloudData && typeof cloudData === 'object') {
        isApplyingCloudRestore = true;
        const normTask = typeof normalizeTask === 'function' ? normalizeTask : (x => x);
        const normHabit = typeof normalizeHabit === 'function' ? normalizeHabit : (x => x);

        state = Object.assign({}, state, cloudData, {
          id: 'primary_workspace',
          isTimerRunning: false,
          pendingOfflineCloudSync: false,
          tasks: Array.isArray(cloudData.tasks) ? cloudData.tasks.map(normTask) : (state.tasks || []),
          habits: Array.isArray(cloudData.habits) ? cloudData.habits.map(normHabit) : (state.habits || []),
          categories: Array.isArray(cloudData.categories) ? cloudData.categories : (state.categories || [])
        });

        enforcePausedTimerAtLastTimeOnStartup();
        hasPulledFromCloudInSession = true;

        const cleanSnap = JSON.parse(JSON.stringify(Object.assign({}, state, {
          id: 'primary_workspace',
          isTimerRunning: false,
          pendingOfflineCloudSync: false
        })));

        const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
        safeLocalSet(fallbackKey, cleanSnap);
        try { localStorage.removeItem(OFFLINE_OUTBOX_KEY); } catch (e) {}

        if (typeof idbPutRecord === 'function') {
          await idbPutRecord(Object.assign({}, cleanSnap, { id: 'primary_workspace' })).catch(() => {});
          await idbPutRecord(Object.assign({}, cleanSnap, { id: 'google_drive_cloud_mirror' })).catch(() => {});
        }

        oauthConfig.lastCloudSync = Date.now();
        oauthConfig.autoSync = true;
        if (typeof saveOAuthConfig === 'function') saveOAuthConfig();

        if (typeof applyThemeAndDir === 'function') applyThemeAndDir();
        if (typeof renderApp === 'function') renderApp();
        if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
        if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');

        const statusEl = document.getElementById('driveModalStatusText');
        if (statusEl) {
          statusEl.textContent = state.lang === 'ar'
            ? '☁️ تم استدعاء ومزامنة أحدث نسخة من Google Cloud بنجاح'
            : '☁️ Latest version pulled & synced from Google Cloud';
        }

        if (!isSilentAutoPull && typeof showToast === 'function') {
          showToast(state.lang === 'ar'
            ? '☁️ تم استدعاء أحدث نسخة من Google Cloud بنجاح!'
            : '☁️ Latest backup pulled from Google Cloud!');
        }
        isApplyingCloudRestore = false;
        return true;
      }
    } catch (err) {
      console.warn('[MunjizCloudFirst] Pull error:', err);
      isApplyingCloudRestore = false;
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('saved_local');
    }
    return false;
  };

  // 5. CRITICAL FIX FOR NEW BROWSER / INCOGNITO:
  // When clicking "Connect Google Drive", ALWAYS pull from Google Cloud FIRST (never overwrite Cloud with blank Incognito state!)
  window.handleGoogleDriveConnect = handleGoogleDriveConnect = function () {
    const inputClient = document.getElementById('inputGoogleClientId');
    const clientId = ((inputClient && inputClient.value ? inputClient.value : '') || oauthConfig.clientId || (typeof DEFAULT_GOOGLE_CLIENT_ID !== 'undefined' ? DEFAULT_GOOGLE_CLIENT_ID : '')).trim();
    if (!clientId) {
      if (typeof showToast === 'function') showToast('Please enter Google OAuth Client ID');
      return;
    }
    oauthConfig.clientId = clientId;
    oauthConfig.autoSync = true;

    // Clear any stale manual token input so OAuth token takes priority
    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    if (directInput) directInput.value = '';

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      if (typeof showToast === 'function') showToast('Google Identity Services script is still loading...');
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

        const statusEl = document.getElementById('driveModalStatusText');
        if (statusEl) {
          statusEl.textContent = state.lang === 'ar'
            ? '✓ تم الاتصال! جاري استدعاء أحدث نسخة من Google Cloud...'
            : '✓ Connected! Pulling latest backup from Google Cloud...';
        }

        // If this browser has pending explicit offline edits made right now, push them;
        // OTHERWISE (like in Incognito or another browser!), PULL the latest backup from Google Cloud!
        const outbox = safeLocalGet(OFFLINE_OUTBOX_KEY);
        if (hasExplicitUserEditInSession && outbox) {
          hasPulledFromCloudInSession = true;
          await syncToGoogleDriveNow(true);
        } else {
          await restoreFromGoogleDriveNow(false);
        }

        if (typeof renderDriveModalState === 'function') renderDriveModalState();
      }
    });

    tokenClient.requestAccessToken({ prompt: '' });
  };

  // Also upgrade saveAndSyncDirectToken to PULL first unless user edited in this session
  window.saveAndSyncDirectToken = saveAndSyncDirectToken = async function () {
    const directInput = document.getElementById('inputDirectAccessToken') || document.getElementById('inputGoogleAccessToken');
    const tok = directInput ? directInput.value.trim() : '';
    if (!tok) return;
    oauthConfig.accessToken = tok;
    oauthConfig.tokenExpiry = Date.now() + 3500 * 1000;
    oauthConfig.autoSync = true;
    if (typeof saveOAuthConfig === 'function') await saveOAuthConfig();

    if (hasExplicitUserEditInSession) {
      hasPulledFromCloudInSession = true;
      await syncToGoogleDriveNow(true);
    } else {
      await restoreFromGoogleDriveNow(false);
    }
  };

  // 6. Upgrade saveState: Only mark user edits when NOT inside initial load or cloud restore
  window.saveState = saveState = async function (triggerExternalAutoSync = true) {
    if (typeof state === 'undefined' || !state) return;
    const isInternalLoad = (triggerExternalAutoSync === 'INTERNAL_NO_SYNC' || isApplyingCloudRestore);

    if (!isInternalLoad) {
      state.lastSaved = Date.now();
      hasExplicitUserEditInSession = true;
    }

    const cleanSnapshot = JSON.parse(JSON.stringify(Object.assign({}, state, {
      id: 'primary_workspace',
      isTimerRunning: false
    })));

    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    safeLocalSet(fallbackKey, cleanSnapshot);
    persistLiveTimerCheckpoint();

    if (!isInternalLoad) {
      if (!navigator.onLine) {
        state.pendingOfflineCloudSync = true;
        cleanSnapshot.pendingOfflineCloudSync = true;
        safeLocalSet(OFFLINE_OUTBOX_KEY, cleanSnapshot);
        safeLocalSet(fallbackKey, cleanSnapshot);
        if (typeof updateSyncStatusBadge === 'function') {
          updateSyncStatusBadge((typeof diskFileHandle !== 'undefined' && diskFileHandle) ? 'synced_disk' : 'offline_queued');
        }
      } else {
        state.pendingOfflineCloudSync = true;
        cleanSnapshot.pendingOfflineCloudSync = true;
        safeLocalSet(OFFLINE_OUTBOX_KEY, cleanSnapshot);
      }
    }

    if (typeof idbPutRecord === 'function') {
      try {
        await idbPutRecord(cleanSnapshot);
      } catch (err) {}
    }

    if (!isInternalLoad && typeof syncChannel !== 'undefined' && syncChannel) {
      try {
        syncChannel.postMessage({
          type: 'STATE_UPDATED',
          timestamp: state.lastSaved,
          payload: cleanSnapshot
        });
      } catch (e) {}
    }

    if (!isInternalLoad) {
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
      autoSyncDebounceTimer = setTimeout(runSync, 300);
    }
  };

  // 7. Cloud Upload (Protected: never uploads blank un-pulled state on a fresh browser unless user edited)
  window.syncToGoogleDriveNow = syncToGoogleDriveNow = async function (isManual = false, useKeepalive = false) {
    if (typeof isCloudSyncInProgress !== 'undefined' && isCloudSyncInProgress && !useKeepalive) return false;

    // If this is a fresh browser session that hasn't pulled from Cloud yet and user hasn't edited anything, PULL first!
    if (!hasPulledFromCloudInSession && !hasExplicitUserEditInSession && !useKeepalive) {
      return await restoreFromGoogleDriveNow(!isManual);
    }

    if (!navigator.onLine) {
      state.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
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
      if (!fileId && !useKeepalive) {
        try {
          fileId = await findDriveBackupFileId(token);
        } catch (e) {}
      }

      const uploadOnce = async (activeToken, targetFileId) => {
        const metadata = { name: BACKUP_FILENAME, mimeType: 'application/json' };
        const boundary = '-------MunjizSyncBoundaryV13';
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

      if ((res.status === 404 || res.status === 403) && fileId) {
        oauthConfig.driveFileId = null;
        fileId = null;
        res = await uploadOnce(token, null);
      }

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
      hasPulledFromCloudInSession = true;
      try { localStorage.removeItem(OFFLINE_OUTBOX_KEY); } catch (e) {}

      if (typeof saveOAuthConfig === 'function') saveOAuthConfig();
      if (typeof idbPutRecord === 'function') {
        idbPutRecord(Object.assign({}, payloadObj, { id: 'primary_workspace' })).catch(() => {});
        idbPutRecord(Object.assign({}, payloadObj, { id: 'google_drive_cloud_mirror' })).catch(() => {});
      }
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('synced_cloud');

      if (isManual && typeof showToast === 'function') {
        showToast(state.lang === 'ar' ? '☁️ تمت المزامنة الفورية مع Google Cloud بنجاح' : '☁️ Synced with Google Cloud');
      }
      return true;
    } catch (err) {
      state.pendingOfflineCloudSync = true;
      safeLocalSet(OFFLINE_OUTBOX_KEY, Object.assign({}, state, { id: 'primary_workspace', isTimerRunning: false }));
      if (typeof updateSyncStatusBadge === 'function') updateSyncStatusBadge('offline_queued');
      return false;
    } finally {
      if (typeof isCloudSyncInProgress !== 'undefined') isCloudSyncInProgress = false;
    }
  };

  window.flushOfflineSyncQueue = flushOfflineSyncQueue = async function () {
    if (!navigator.onLine) return false;
    const outbox = safeLocalGet(OFFLINE_OUTBOX_KEY);
    if (!outbox && !hasExplicitUserEditInSession) {
      // No local offline edits -> pull latest from Google Cloud!
      return await restoreFromGoogleDriveNow(true);
    }
    if (outbox && Number(outbox.lastSaved || 0) > Number(state.lastSaved || 0)) {
      const wasRunning = state.isTimerRunning;
      state = Object.assign({}, state, outbox, { isTimerRunning: Boolean(wasRunning) });
    }
    hasPulledFromCloudInSession = true;
    const ok = await syncToGoogleDriveNow(false);
    if (ok && typeof showToast === 'function') {
      showToast(state.lang === 'ar' ? '🌐 عاد الإنترنت: تم رفع التعديلات الأوفلاين فوراً!' : '🌐 Online: Offline edits synced to Cloud!');
    }
    return ok;
  };

  // 8. Upgrade loadState: Load local cache for instant UI, then IMMEDIATELY pull latest from Google Cloud
  const originalLoadState = typeof loadState === 'function' ? loadState : null;
  window.loadState = loadState = async function () {
    if (originalLoadState) {
      try {
        await originalLoadState();
      } catch (e) {}
    }

    const fallbackKey = typeof LOCAL_FALLBACK_KEY !== 'undefined' ? LOCAL_FALLBACK_KEY : 'munjiz_workspace_v6_fallback';
    const localSnap = safeLocalGet(fallbackKey);
    const outboxSnap = safeLocalGet(OFFLINE_OUTBOX_KEY);

    if (outboxSnap && Number(outboxSnap.lastSaved || 0) >= Number(state.lastSaved || 0)) {
      state = Object.assign({}, state, outboxSnap);
      hasExplicitUserEditInSession = true;
    } else if (localSnap && Number(localSnap.lastSaved || 0) >= Number(state.lastSaved || 0)) {
      state = Object.assign({}, state, localSnap);
    }

    // If local state has empty tasks & habits (from the accidental Incognito wipe), restore known good backup immediately
    if (
      Array.isArray(state.tasks) && state.tasks.length === 0 &&
      Array.isArray(state.habits) && state.habits.length === 0 &&
      LAST_KNOWN_GOOD_BACKUP && Array.isArray(LAST_KNOWN_GOOD_BACKUP.tasks)
    ) {
      state = Object.assign({}, state, LAST_KNOWN_GOOD_BACKUP, { isTimerRunning: false });
    }

    enforcePausedTimerAtLastTimeOnStartup();

    if (typeof oauthConfig !== 'undefined' && oauthConfig) {
      if (!oauthConfig.clientId && typeof DEFAULT_GOOGLE_CLIENT_ID !== 'undefined') {
        oauthConfig.clientId = DEFAULT_GOOGLE_CLIENT_ID;
      }
      oauthConfig.autoSync = true;
    }

    await saveState('INTERNAL_NO_SYNC');

    // Immediately pull the latest state from Google Cloud (Single Source of Truth)
    setTimeout(async () => {
      if (!navigator.onLine) return;
      if (hasExplicitUserEditInSession && safeLocalGet(OFFLINE_OUTBOX_KEY)) {
        await flushOfflineSyncQueue();
      } else {
        await restoreFromGoogleDriveNow(true);
      }
    }, 250);
  };

  // 9. Timer Controls (Paused on reload + Drift-free 1s tick + Per-second checkpoint)
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
    if (hasExplicitUserEditInSession && navigator.onLine && typeof oauthConfig !== 'undefined' && oauthConfig && oauthConfig.accessToken) {
      syncToGoogleDriveNow(false, true);
    }
  }

  window.addEventListener('pagehide', () => handleAppCloseOrHide(true));
  window.addEventListener('beforeunload', () => handleAppCloseOrHide(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      handleAppCloseOrHide(false);
    } else if (document.visibilityState === 'visible' && navigator.onLine) {
      // When switching back to this browser/tab, pull latest changes if no pending offline edits
      if (safeLocalGet(OFFLINE_OUTBOX_KEY) && hasExplicitUserEditInSession) {
        flushOfflineSyncQueue();
      } else {
        restoreFromGoogleDriveNow(true);
      }
    }
  });

  window.addEventListener('online', () => {
    flushOfflineSyncQueue();
  });

  if (!periodicSyncHeartbeat) {
    periodicSyncHeartbeat = setInterval(() => {
      if (navigator.onLine && typeof state !== 'undefined' && state && state.pendingOfflineCloudSync && hasExplicitUserEditInSession) {
        flushOfflineSyncQueue();
      }
    }, 12000);
  }

  if (document.readyState !== 'loading') {
    enforcePausedTimerAtLastTimeOnStartup();
    if (typeof renderFocusTimerWidget === 'function') renderFocusTimerWidget();
  }
})();