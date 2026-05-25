// ==UserScript==
// @name         Central Fellas 142 - Players
// @namespace    central-fellas-players
// @version      7.0
// @description  Central de Comandos
// @author       APOSENTADOS
// @match        *://br142.tribalwars.*/game.php*
// @match        *://br142.guerrastribais.*/game.php*
// @match        *://br142.tribalwars.com.br/game.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/Matheusfjuca/centralatt/main/central-fellas-players.user.js
// @downloadURL  https://raw.githubusercontent.com/Matheusfjuca/centralatt/main/central-fellas-players.user.js
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const RUN_KEY = '_central_fellas_players_7.0_';
  if (window[RUN_KEY]) return;
  window[RUN_KEY] = true;

  const VERSION_TEXT = 'v7.0';

  // Session ID único POR ABA (controle de abas no servidor) — usa sessionStorage para diferenciar abas
  let SESSION_ID = sessionStorage.getItem('fellas_tab_session_id');
  if (!SESSION_ID) {
    SESSION_ID = 'fellas_tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    sessionStorage.setItem('fellas_tab_session_id', SESSION_ID);
  }


  // ===== VERSÃO MINIMAL: SEM CONTROLE DE SENHA =====
  // Versão minimal não precisa de senha pois não tem interface/painel

  const DEFAULT_AXE_ICON = 'https://dsbr.innogamescdn.com/asset/636f8dd3/graphic/command/attack.webp';
  const NOBLE_ICON       = 'https://dsbr.innogamescdn.com/asset/d78cd800/graphic/unit/tiny/snob.webp';
  const SUPPORT_ICON     = 'https://dsbr.innogamescdn.com/asset/4e165360/graphic/command/support.webp';
  const RIP_LOGO_URL     = '';

  // ===== CONTROLE DE MUNDOS PERMITIDOS =====
  const ALLOWED_WORLDS = ['br142'];

  function isWorldAllowed(world) {
    if (!world) return false;
    const normalized = world.toLowerCase().trim();
    return ALLOWED_WORLDS.includes(normalized);
  }

  const hostWorld = (location.hostname.match(/(?:^|\.)([a-z]{2}\d{1,3})\./i)?.[1] || '').toLowerCase();

  // Bloquear se não conseguir detectar o mundo corretamente (evita funcionar em mundos casuais com formato diferente)
  if (!hostWorld || hostWorld.trim() === '') {
    return;
  }

  const cfg = {
    serverURL: GM_getValue('tw_serverURL', 'https://fellas.centraltw.com.br'),
    authToken: GM_getValue('tw_authToken', 'br142'),
    commandsServerURL: GM_getValue('tw_commandsServerURL', 'https://fellas.centraltw.com.br'), // Mesmo servidor
    commandsAuthToken: GM_getValue('tw_commandsAuthToken', 'br142'), // Mesmo token (agora é tudo no mesmo servidor)
    world:     hostWorld.toLowerCase().trim(),
    debug:     GM_getValue('tw_debug',      false),
    colorizeEnabled: GM_getValue('tw_colorize_enabled', true),
    supportsVisible: GM_getValue('tw_supports_visible', true),
    provisionalEnabled: GM_getValue('tw_provisional_enabled', true),
    showIgnored: GM_getValue('tw_show_ignored', false),


    selectors: {
      incomingTable: '#incomings_table',
      commandsTable: '#commands_table', // Tabela de comandos enviados
      rows: 'tbody > tr.nowrap, tbody > tr[class*="row_"], tbody > tr:has(td)'
    }
  };

  // ===== BLOQUEIO DE MUNDOS NÃO AUTORIZADOS =====
  if (!isWorldAllowed(cfg.world)) {
    return;
  }

  GM_setValue('tw_world', cfg.world);

  const AXE_MULTI_KEY = 'tw_axe_multi_v1';
  function loadAxeSelected(){
    try {
      const arr = JSON.parse(GM_getValue(AXE_MULTI_KEY, '["all"]'));
      return new Set(Array.isArray(arr) ? arr : ['all']);
    } catch { return new Set(['all']); }
  }
  function saveAxeSelected(set){
    try { GM_setValue(AXE_MULTI_KEY, JSON.stringify([...set])); } catch {}
  }
  let axeSelected = loadAxeSelected();

  const CACHE_KEY = 'tw_last_remote_cache_v1';
  const CACHE_AT  = 'tw_last_remote_cache_at_v1';
  const IGNORED_CACHE_KEY = 'tw_ignored_ids_v1';
  // TTL alinhado com o ciclo de background (7min)
  const IGNORED_CACHE_TTL_MS = 420_000;
  const IGNORED_SERVER_CACHE_KEY = 'tw_ignored_ids_server_v1';
  const IGNORED_SERVER_CACHE_AT  = 'tw_ignored_ids_server_at_v1';
  const IGNORED_SERVER_TTL_MS    = 420_000;
  let ignoredCombined = new Set();
  // Controle em memória para evitar múltiplos fetches de ignorados dentro do TTL
  let __ignoredLastFetchTs = 0;
  let __ignoredLastIds = new Set();
  let __ignoredInitDone = false;

  const OPEN_PLAYERS = new Set((() => { try { return JSON.parse(GM_getValue('tw_open_players','[]')); } catch { return []; } })());
  const OPEN_VILLAGES = new Set((() => { try { return JSON.parse(GM_getValue('tw_open_villages','[]')); } catch { return []; } })());
  function persistOpenSets(){
  try {
      GM_setValue('tw_open_players', JSON.stringify([...OPEN_PLAYERS]));
      GM_setValue('tw_open_villages', JSON.stringify([...OPEN_VILLAGES]));
    } catch {}
  }

  // Chaves do cache persistente e funções do Captcha/Status
  const PERSISTENT_ATTACKS_CACHE_KEY = 'tw_persistent_attacks_cache_v2';
  const PERSISTENT_COMMANDS_CACHE_KEY = 'tw_persistent_commands_cache_v2';

  function getPersistentCache(key) {
    try {
      const raw = GM_getValue(key, '{}');
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  function savePersistentCache(key, data) {
    try {
      if (data && typeof data === 'object') {
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000; // 24 horas atrás
        const items = [];
        
        // 1) Filtrar expirados (mais velhos que 24h atrás)
        for (const id in data) {
          const item = data[id];
          if (item && item.arrival_at && item.arrival_at >= cutoff) {
            items.push([id, item]);
          }
        }

        // 2) Se ultrapassar o teto de 5000 itens, manter os 5000 mais recentes / futuros
        if (items.length > 5000) {
          items.sort((a, b) => (b[1].arrival_at || 0) - (a[1].arrival_at || 0));
          items.length = 5000;
        }

        const prunedData = {};
        for (const [id, item] of items) {
          prunedData[id] = item;
        }
        GM_setValue(key, JSON.stringify(prunedData));
      } else {
        GM_setValue(key, JSON.stringify(data || {}));
      }
    } catch {}
  }

  function isCaptchaPage() {
    try {
      return window.location.href.includes('bot_protection') || 
             document.querySelector('#bot_protection') !== null ||
             document.querySelector('.bot-protection') !== null ||
             document.querySelector('form[action*="bot_protection"]') !== null;
    } catch (e) {
      return false;
    }
  }

  function updateStatusIndicator(btnId, state) {
    try {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const dot = btn.querySelector('.be-status-dot');
      if (!dot) return;
      
      let color = '#28a745'; // success -> verde
      if (state === 'pending') {
        color = '#ffc107'; // pending -> amarelo
      } else if (state === 'error') {
        color = '#dc3545'; // error -> vermelho
      }
      dot.style.backgroundColor = color;
    } catch (e) {
      // Ignorar erros silenciosamente
    }
  }

  function pruneExpiredCaches() {
    try {
      const now = Date.now();
      const limit = now - 24 * 60 * 60 * 1000; // 24 horas atrás
      let prunedAttacks = 0;
      let prunedCommands = 0;

      const attacksCache = getPersistentCache(PERSISTENT_ATTACKS_CACHE_KEY);
      for (const id in attacksCache) {
        const item = attacksCache[id];
        if (item && item.arrival_at && item.arrival_at < limit) {
          delete attacksCache[id];
          prunedAttacks++;
        }
      }
      savePersistentCache(PERSISTENT_ATTACKS_CACHE_KEY, attacksCache);

      const commandsCache = getPersistentCache(PERSISTENT_COMMANDS_CACHE_KEY);
      for (const id in commandsCache) {
        const item = commandsCache[id];
        if (item && item.arrival_at && item.arrival_at < limit) {
          delete commandsCache[id];
          prunedCommands++;
        }
      }
      savePersistentCache(PERSISTENT_COMMANDS_CACHE_KEY, commandsCache);
    } catch (e) {
      // Falha silenciosa
    }
  }

  // Log de debug simples — manter ligado enquanto ajustamos lógica de páginas
  const dlog = () => {}; // Logs desabilitados

  const __BE_SCRIPT_NAME = 'Players';
  let __beLoggedBoot = false;
  let __beLoggedSession = false;
  let __beLoggedBlocked = false;
  let __beSessionActive = false; // ativa = sessão primária (servidor aceitou)
  let __beBlocked = false;

  // Sistema de comunicação entre abas para coordenar envio
  let __broadcastChannel = null;
  let __isSpecialPage = false; // true se está em incomings ou commands
  let __isSendingActive = false; // true se esta aba está enviando ativamente
  let __activeSpecialPages = new Set(); // Rastrear quais tipos de páginas especiais estão ativas

  function initBroadcastChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    if (__broadcastChannel) return;

    // Verificar se as funções já estão definidas antes de chamar
    if (typeof isIncomingsPage === 'undefined' || typeof isCommandsPage === 'undefined') {
      // Aguardar um pouco e tentar novamente
      setTimeout(initBroadcastChannel, 100);
      return;
    }

    __broadcastChannel = new BroadcastChannel('be_players_sync');
    updateSpecialPageFlag();

    __broadcastChannel.onmessage = (event) => {
      const { type, sessionId, pageType } = event.data || {};

      // Ignorar mensagens da própria aba
      if (sessionId === SESSION_ID) return;

      if (type === 'special_page_active') {
        // Adicionar ao conjunto de páginas especiais ativas
        if (pageType) {
          __activeSpecialPages.add(pageType);
        }

        // Se esta aba NÃO está em página especial, deve parar
        // Mas só se AMBAS as páginas especiais estiverem cobertas (incomings E commands)
        if (!__isSpecialPage && !__beBlocked) {
          // Só bloquear se ambas as páginas especiais estiverem ativas
          if (__activeSpecialPages.has('incomings') && __activeSpecialPages.has('commands')) {
            dlog(`📢 [Broadcast] Recebido: ambas páginas especiais ativas (${Array.from(__activeSpecialPages).join(', ')}). Esta aba vai parar.`);
            __beLogBlockedOnce('outra aba (páginas especiais ativas)');
          } else {
            dlog(`📢 [Broadcast] Recebido: página especial ${pageType} ativa. Abas normais ainda podem enviar.`);
          }
        }
      } else if (type === 'special_page_inactive') {
        // Remover do conjunto de páginas especiais ativas
        if (pageType) {
          __activeSpecialPages.delete(pageType);
        }

        // Se não há mais páginas especiais ativas, outras abas podem retomar
        if (__beBlocked && !__isSpecialPage && __activeSpecialPages.size === 0) {
          dlog(`📢 [Broadcast] Recebido: todas páginas especiais pararam. Esta aba pode retomar.`);
          // Não desbloqueia automaticamente - espera próxima tentativa de envio
        }
      }
    };

    dlog(`📡 [Broadcast] Canal de comunicação inicializado (página especial: ${__isSpecialPage})`);
  }

  // Atualizar flag de página especial quando necessário
  function updateSpecialPageFlag() {
    __isSpecialPage = isIncomingsPage() || isCommandsPage();
  }

  function notifySpecialPageActive() {
    if (!__broadcastChannel || !__isSpecialPage) return;
    const pageType = isIncomingsPage() ? 'incomings' : 'commands';
    __broadcastChannel.postMessage({
      type: 'special_page_active',
      sessionId: SESSION_ID,
      pageType: pageType,
      timestamp: Date.now()
    });
    __activeSpecialPages.add(pageType);
    __isSendingActive = true;
  }

  function notifySpecialPageInactive() {
    if (!__broadcastChannel || !__isSpecialPage) return;
    const pageType = isIncomingsPage() ? 'incomings' : 'commands';
    __broadcastChannel.postMessage({
      type: 'special_page_inactive',
      sessionId: SESSION_ID,
      pageType: pageType,
      timestamp: Date.now()
    });
    __activeSpecialPages.delete(pageType);
    __isSendingActive = false;
  }

  async function __beGetIdentity() {
    try {
      // 1) Tentar obter nome do jogador pelo DOM (rápido e sem carregar banco de dados)
      const playerDom = getLoggedPlayerNameFromDOM();

      // 2) Verificar se temos cache da identidade salvo
      const cachedPlayer = GM_getValue('tw_cached_identity_player');
      const cachedTribe = GM_getValue('tw_cached_identity_tribe');

      if (playerDom && playerDom === cachedPlayer && cachedTribe) {
        return { player: playerDom, tribo: cachedTribe };
      }

      // 3) Se mudou ou não tem cache, tentar resolver sem loadWorldData usando busca pontual
      const playerId = getPlayerIdFromScripts();
      if (playerId) {
        const CACHE_KEY = `world_data_${cfg.world}`;
        const cachedDataRaw = GM_getValue(CACHE_KEY);
        if (cachedDataRaw) {
          try {
            const data = JSON.parse(cachedDataRaw);
            if (data && data.jogadores) {
              const pData = data.jogadores.find(item => Array.isArray(item) && String(item[0]) === String(playerId));
              if (pData) {
                const nameFromWorld = normalizeName(pData[1] || '');
                const idTribo = pData[2] || '0';
                let tribeTag = 'NULL';
                if (idTribo !== '0' && data.tribos) {
                  const tData = data.tribos.find(item => Array.isArray(item) && String(item[0]) === String(idTribo));
                  if (tData) {
                    tribeTag = normalizeName(tData[1] || '');
                  }
                }
                GM_setValue('tw_cached_identity_player', nameFromWorld);
                GM_setValue('tw_cached_identity_tribe', tribeTag);
                return { player: nameFromWorld, tribo: tribeTag };
              }
            }
          } catch (e) {}
        }
      }

      // 4) Se tudo falhar, usar loadWorldData() de forma preguiçosa
      if (!MUNDO_DADOS || !MUNDO_DADOS.loaded) {
        try { await loadWorldData(); } catch {}
      }
      const player = normalizeName(getLoggedPlayerName() || '') || 'Desconhecido';
      const tribo = normalizeName(getLoggedPlayerTribeTag() || '') || 'NULL';

      if (player && player !== 'Jogador Desconhecido') {
        GM_setValue('tw_cached_identity_player', player);
        GM_setValue('tw_cached_identity_tribe', tribo);
      }
      return { player, tribo };
    } catch {
      return { player: 'Desconhecido', tribo: 'NULL' };
    }
  }

  async function __beLogBootOnce() {
    // Log de boot removido - apenas logs de sessão ativa e bloqueio são mostrados
  }

  async function __beLogSessionOnce() {
    if (__beLoggedSession) return;
    __beLoggedSession = true;
    const { player, tribo } = await __beGetIdentity();
    // Mostrar log apenas se não estiver bloqueada (aba primária ou secundária não bloqueada ainda)
    if (!__beBlocked) {
      console.log(`[Central Fellas] ${__BE_SCRIPT_NAME} ${VERSION_TEXT} - Player: ${player} - Tribo: ${tribo}`);
    }
  }

  async function __beLogBlockedOnce(reason) {
    if (__beLoggedBlocked) return;
    __beLoggedBlocked = true;
    __beBlocked = true;
    __beSessionActive = false;
    const { player, tribo } = await __beGetIdentity();
    console.log(`[Central Fellas] BLOQUEADO (${reason || 'outra aba'}) - Script não vai funcionar nesta aba - ${__BE_SCRIPT_NAME} ${VERSION_TEXT} - Player: ${player} - Tribo: ${tribo}`);
  }

  function __beStopSendingOnly() {
    try { stopHeartbeat?.(); } catch {}
    try { if (__backgroundSyncTimer) { clearTimeout(__backgroundSyncTimer); __backgroundSyncTimer = null; } } catch {}
    try { __netQueue?.clear?.(); } catch {}
    try { __commandsQueue?.clear?.(); } catch {}
  }

  function __beMarkActiveAndLogIfNeeded() {
    if (__beBlocked) return;
    if (!__beSessionActive) {
      __beSessionActive = true;
      __beLogSessionOnce();
      // Quando a aba se torna ativa, atualizar lista de ignorados
      refreshIgnoredCombined().catch(() => {});
    }
  }
  const esc  = s => (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const colorSettings = [
    ['[Rezar]', '[Morto]', '[Desviado]', '[Desviar]', '[Reconquistar]', '[Reconquistado]', '[Snipado]', '[Snipar]','[Fubar]', '[Snipe Cancel]', '[Fake]', '[Possível Full]', '[Reforçar]', ' | Retirar', ' | Vigiar', ' | ✓'],
    ['人'      , 'M'      , 'D!'        , 'D'        , 'R'             , 'RR'             , 'S!'       , 'S'       , 'FU'    ,'SC'             , 'FA' , 'PV', 'RF', 'R!', 'V!', '✓'],
    ['blue'    , 'green'  , 'orange'    , 'dorange'  , 'gray'          , 'white'          , 'lblue'    , 'blue'    , 'dgreen','red'            , 'Pink', 'dblue', 'black', 'dgreen', 'yellow','lgreen' ],
    ['white' , 'white'  , 'white'     , 'white'    , 'white'         , 'black'          , 'white'    , 'white'   , 'white' ,'white'          , 'white', 'white', 'white', 'white' , 'white','white']
  ];
  const colors = [
    ['red', 'green', 'blue', 'yellow', 'orange', 'lblue', 'lime', 'white', 'black', 'gray', 'dorange', 'black', 'Pink', 'brown','dblue','dgreen','lgreen'],
    ['#e20606', '#31c908', '#0d83dd', '#ffd91c', '#ef8b10', '#22e5db', '#ffd400', '#ffffff', '#000000', '#adb6c6', '#9232a8', '#40434E', '#FFC0CB', '#892929','#00007f','#004c00','#93cf82'],
    ['#ff0000', '#228c05', '#0860a3', '#e8c30d', '#d3790a', '#0cd3c9', '#ffd400', '#dbdbdb', '#000000', '#828891', '#9232a8', '#40434E','#FFC0CB' , '#892929','#00007f','#004c00','#93cf82' ]
  ];
  function getCommandColor(commandType) {
    if (!commandType) return null;
    for (let i = 0; i < colorSettings[0].length; i++) {
      const settingCommand = colorSettings[0][i];
      if (commandType.includes(settingCommand) || settingCommand.includes(commandType)) {
        const colorName = colorSettings[2][i];
        const colorIndex = colors[0].indexOf(colorName);
        if (colorIndex !== -1) {
          return {
            background: colors[1][colorIndex],
            color: colors[1][colors[0].indexOf(colorSettings[3][i])] || '#ffffff'
          };
        }
      }
    }
    return {
      background: colors[2][colors[0].indexOf('red')],
      color: colors[1][colors[0].indexOf('white')]
    };
  }

  function buildIconVariant(src, variant){
    try{
      if(!src) src = DEFAULT_AXE_ICON;
      const u = new URL(src, location.origin);
      const m = u.pathname.match(/(attack)(?:_(small|medium|large))?(\.(?:png|webp))/i);
      if (m) {
        const ext = m[3];
        const basePath = u.pathname.replace(m[0], '');
        const name = variant==='base' ? 'attack' : `attack_${variant}`;
        u.pathname = basePath + name + ext;
        return u.toString();
      }
      return src.replace(/attack(?:_(small|medium|large))?\.(png|webp)$/i, `attack_${variant}.$2`);
    }catch{ return src; }
  }

  function isSupport(a){
    const t = (a.type || '').toLowerCase();
    const k = (a.icon_key || '').toLowerCase();
    const s = (a.icon_src || '').toLowerCase();
    return t.includes('apoio') || t.includes('support') || k.includes('support') || s.includes('support');
  }
  function isLargeConfirmed(a){
    const k = (a.icon_key || '').toLowerCase();
    const s = (a.icon_src || '').toLowerCase();
    const sz = (a.axe_size || '').toLowerCase();
    const bySize = sz === 'large';
    const byKey  = /attack_large$/.test(k) || k.includes('attack_large');
    const bySrc  = /\/attack_large\.(png|webp)/.test(s);
    return bySize || byKey || bySrc;
  }
  function getAxeType(a){
    if (a.provisional && a.provisional_kind === 'small_medium') return 'small_medium';
    const sz = (a.axe_size||'').toLowerCase();
    if (sz==='small') return 'small';
    if (sz==='medium') return 'medium';
    if (isLargeConfirmed(a)) return 'large';
    if (sz==='large') return 'large';
    return 'unknown';
  }
  function isNoble(a){ return (a.type||'').toLowerCase().includes('nobre'); }
  function isNormal(a){
    if (isSupport(a)) return false;
    if (isNoble(a)) return false;
    return getAxeType(a)==='unknown';
  }

  // Atualização automática via Tampermonkey (@updateURL) - não precisa de verificação manual

  // ===== DISCORD NOTIFICATIONS =====
  let __discordNotificationsSent = new Set();

  async function sendDiscordNoble(attack) {
    if (!cfg.discordEnabled || !cfg.discordWebhook) return;

    try {
      // Validar e formatar data de chegada
      const arrivalTimestamp = parseInt(attack.arrival_at) || 0;
      const arrivalTime = new Date(arrivalTimestamp);
      const timeLeft = Math.max(0, Math.floor((arrivalTimestamp - Date.now()) / 1000));
      const hours = Math.floor(timeLeft / 3600);
      const minutes = Math.floor((timeLeft % 3600) / 60);
      const seconds = timeLeft % 60;

      const timeString = timeLeft > 0
        ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
        : 'CHEGOU!';

      // Formatação segura da data
      const arrivalString = isNaN(arrivalTime.getTime())
        ? 'Data inválida'
        : arrivalTime.toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });

      const payload = {
        content: `⚔️ **NOBRE DETECTADO!**`,
        embeds: [{
          title: "🏰 Ataque Nobre",
          color: 0xff0000,
          fields: [
            { name: "👤 Atacante", value: attack.attacker || 'Desconhecido', inline: true },
            { name: "🎯 Alvo", value: attack.target || 'Desconhecido', inline: true },
            { name: "⏰ Chegada", value: arrivalString, inline: true },
            { name: "⏱️ Tempo Restante", value: timeString, inline: true },
            { name: "🌍 Mundo", value: cfg.world.toUpperCase(), inline: true },
            { name: "📍 Origem", value: attack.origin || 'Desconhecido', inline: true }
          ],
          footer: {
            text: `Central Fellas ${VERSION_TEXT} • ${new Date().toLocaleString('pt-BR')}`
          }
        }]
      };

      await fetch(cfg.discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      dlog(`📤 Discord: Nobre enviado - ${attack.attacker} → ${attack.target}`);
    } catch (e) {
      dlog('Erro ao enviar nobre para Discord:', e);
    }
  }

  async function sendDiscordNobleGroup(nobleAttacks) {
    if (!cfg.discordEnabled || !cfg.discordWebhook) return;

    try {
      const firstAttack = nobleAttacks[0];
      const isTrain = nobleAttacks.length > 1;

      // Formatar horários dos nobres
      const nobleTimes = nobleAttacks.map(attack => {
        const arrivalTimestamp = parseInt(attack.arrival_at) || 0;
        const arrivalTime = new Date(arrivalTimestamp);
        const timeLeft = Math.max(0, Math.floor((arrivalTimestamp - Date.now()) / 1000));
        const hours = Math.floor(timeLeft / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        const seconds = timeLeft % 60;

        const timeString = timeLeft > 0
          ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
          : 'CHEGOU!';

        const arrivalString = isNaN(arrivalTime.getTime())
          ? 'Data inválida'
          : arrivalTime.toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            }) + ':' + (arrivalTime.getMilliseconds() || 0).toString().padStart(3, '0');

        return `• ${arrivalString} (${timeString})`;
      }).join('\n');

      // Agrupar por atacante para mostrar múltiplos atacantes
      const attackers = [...new Set(nobleAttacks.map(a => a.attacker))];
      const attackerList = attackers.length > 1
        ? `${attackers.length} atacantes: ${attackers.join(', ')}`
        : firstAttack.attacker || 'Desconhecido';

      const payload = {
        content: isTrain ? `⚔️ **NOBRE TRAIN DETECTADO!** (${nobleAttacks.length} nobres na aldeia ${firstAttack.target})` : `⚔️ **NOBRE DETECTADO!**`,
        embeds: [{
          title: isTrain ? `🏰 Ataque Nobre Train - ${firstAttack.target}` : "🏰 Ataque Nobre",
          color: 0xff0000,
          fields: [
            { name: "👤 Atacante(s)", value: attackerList, inline: true },
            { name: "🛡️ Defensor", value: firstAttack.defender || 'Desconhecido', inline: true },
            { name: "🎯 Aldeia Alvo", value: firstAttack.target || 'Desconhecido', inline: true },
            { name: "🌍 Mundo", value: cfg.world.toUpperCase(), inline: true },
            { name: "📍 Origem", value: firstAttack.origin || 'Desconhecido', inline: true },
            { name: isTrain ? "⏰ Horários dos Nobres" : "⏰ Chegada", value: nobleTimes, inline: false }
          ],
          footer: {
            text: `Central Fellas ${VERSION_TEXT} • ${new Date().toLocaleString('pt-BR')}`
          }
        }]
      };

      await fetch(cfg.discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      dlog(`📤 Discord: ${isTrain ? 'Nobre Train' : 'Nobre'} enviado - ${firstAttack.attacker} → ${firstAttack.target} (${nobleAttacks.length} nobres)`);
    } catch (e) {
      dlog('Erro ao enviar nobre train para Discord:', e);
    }
  }

  function checkDiscordNobles(attacks) {
    // Só notifica se painel estiver aberto (líder logado)
    if (!cfg.discordEnabled || !cfg.discordWebhook) return;
    if (isPaused()) return; // Painel fechado = não notifica

    const now = Date.now();

    // Agrupar nobres por aldeia alvo (target) - notificação única por aldeia
    const nobleGroups = new Map();

    attacks.forEach(attack => {
      if (!isNoble(attack)) return;
      if (attack.arrival_at <= now) return;

      // Agrupar apenas por aldeia alvo (target)
      const groupKey = attack.target;
      if (!nobleGroups.has(groupKey)) {
        nobleGroups.set(groupKey, []);
      }
      nobleGroups.get(groupKey).push(attack);
    });

    // Processar cada grupo
    nobleGroups.forEach((nobleAttacks, groupKey) => {
      if (nobleAttacks.length === 0) return;

      // Verificar se já notificou este grupo
      const notificationKey = `group_${groupKey}`;
      if (__discordNotificationsSent.has(notificationKey)) return;

      // Ordenar por horário de chegada
      nobleAttacks.sort((a, b) => {
          let timeA = Number(a.arrival_at);
          let timeB = Number(b.arrival_at);
          if (isNaN(timeA)) timeA = parseArrivalAbsolute(a.arrival_at);
          if (isNaN(timeB)) timeB = parseArrivalAbsolute(b.arrival_at);
          if (timeA !== timeB) return timeA - timeB;
          const idA = a.command_id ? String(a.command_id) : '0';
          const idB = b.command_id ? String(b.command_id) : '0';
          return idA.localeCompare(idB, undefined, { numeric: true });
        });

      // Enviar notificação do grupo
      sendDiscordNobleGroup(nobleAttacks);
      __discordNotificationsSent.add(notificationKey);
    });
  }

  function cleanupDiscordNotifications() {
    const now = Date.now();
    const expiredKeys = [];

    __discordNotificationsSent.forEach(key => {
      const parts = key.split('_');
      if (parts.length < 3) {
        expiredKeys.push(key);
        return;
      }

      const [commandId, target, attacker] = parts;
      const attack = cache.find(a =>
        a.command_id === commandId &&
        a.target === target &&
        a.attacker === attacker
      );

      if (!attack || attack.arrival_at <= now) {
        expiredKeys.push(key);
      }
    });

    expiredKeys.forEach(key => __discordNotificationsSent.delete(key));
    if (expiredKeys.length > 0) {
      dlog(`Discord: ${expiredKeys.length} notificações expiradas removidas`);
    }
  }
  function txt(el){ try { return (el?.textContent || '').replace(/\s+/g,' ').trim(); } catch { return ''; } }

  function normalizeIconKeyFromURL(url){const base=(url.split('?')[0]||'').split('/').pop()||'';return base.replace(/\.(png|webp)$/i,'').toLowerCase();}
  function detectAxeSizeFromKey(key){if(!key)return'unknown';if(/attack_small$/i.test(key))return'small';if(/attack_medium$/i.test(key))return'medium';if(/attack_large$/i.test(key))return'large';if(/^attack$/i.test(key))return'base';return'unknown';}

  // Função para detectar tipo de comando baseado nos ícones presentes na célula
  function detectCommandTypeFromIcons(td) {
    if (!td) return { type: 'Ataque', icon_key: '', icon_src: '', icon_alt: '', isNoble: false, isRam: false, isCatapult: false };

    // Buscar TODOS os ícones na célula (não apenas o primeiro)
    const allImgs = td.querySelectorAll('img');
    const iconData = [];

    allImgs.forEach((img, idx) => {
      const src = img.src || '';
      const alt = (img.getAttribute('alt') || '').trim();
      const title = (img.getAttribute('title') || '').trim();
      const className = img.className || '';
      if (src) {
        iconData.push({ src, alt, title, className, img });
        if (cfg.debug) dlog(`  🔍 [Commands] Ícone ${idx + 1}: src="${src.substring(0, 100)}", alt="${alt}", title="${title}", class="${className}"`);
      }
    });

    if (cfg.debug) dlog(`  🔍 [Commands] Total de ${iconData.length} ícone(s) encontrado(s) na célula`);

    // Analisar URLs e alts para determinar tipo
    let type = 'Ataque';
    let icon_key = '';
    let icon_src = '';
    let icon_alt = '';
    let isNoble = false;
    let isRam = false;
    let isCatapult = false;

    // Primeiro, procurar por ícones de unidades específicas (nobre, spy, etc.) - têm prioridade
    for (const icon of iconData) {
      const urlLower = icon.src.toLowerCase();
      const normalizedKey = normalizeIconKeyFromURL(icon.src);
      const altLower = (icon.alt || '').toLowerCase();
      const titleLower = (icon.title || '').toLowerCase();
      const combinedText = `${altLower} ${titleLower}`;

      // Detectar Nobre (prioridade máxima)
      if (urlLower.includes('/unit/tiny/snob') || urlLower.includes('/unit/snob') ||
          urlLower.includes('snob') || normalizedKey.includes('snob') ||
          urlLower.includes('/unit/tiny/noble') || urlLower.includes('/unit/noble') ||
          combinedText.includes('nobre') || combinedText.includes('noble') || combinedText.includes('snob') ||
          icon.className.includes('noble') || icon.className.includes('snob')) {
        icon_key = normalizedKey || 'snob';
        icon_src = icon.src;
        icon_alt = icon.alt || icon.title || '';
        isNoble = true;

        // Verificar se há um ícone de ataque junto (para detectar cor do machado)
        let axeSize = 'unknown';
        const allIconsInCell = td.querySelectorAll('img');
        for (const otherImg of allIconsInCell) {
          const otherSrc = otherImg.src || '';
          const otherUrlLower = otherSrc.toLowerCase();
          const otherNormalizedKey = normalizeIconKeyFromURL(otherSrc);

          if (otherSrc !== icon.src && otherUrlLower.includes('/graphic/command/attack')) {
            if (otherNormalizedKey.includes('attack_small')) {
              axeSize = 'small';
            } else if (otherNormalizedKey.includes('attack_medium')) {
              axeSize = 'medium';
            } else if (otherNormalizedKey.includes('attack_large')) {
              axeSize = 'large';
            } else if (otherNormalizedKey.includes('attack')) {
              axeSize = 'large';
            }
            break;
          }
        }

        if (axeSize === 'small') {
          type = 'Ataque com Nobre (Small)';
        } else if (axeSize === 'medium') {
          type = 'Ataque com Nobre (Medium)';
        } else if (axeSize === 'large') {
          type = 'Ataque com Nobre (Large)';
        } else {
          type = 'Ataque com Nobre';
        }
        break;
      }

      // Detectar Ariete
      if (urlLower.includes('/unit/tiny/ram') || urlLower.includes('ram') || normalizedKey.includes('ram') ||
          combinedText.includes('ariete') || combinedText.includes('ram')) {
        type = 'Ataque com Ariete';
        icon_key = normalizedKey || 'ram';
        icon_src = icon.src;
        icon_alt = icon.alt || icon.title || '';
        isRam = true;
        break;
      }

      // Detectar Catapulta
      if (urlLower.includes('/unit/tiny/catapult') || urlLower.includes('catapult') || normalizedKey.includes('catapult') ||
          combinedText.includes('catapulta') || combinedText.includes('catapult')) {
        type = 'Ataque com Catapulta';
        icon_key = normalizedKey || 'catapult';
        icon_src = icon.src;
        icon_alt = icon.alt || icon.title || '';
        isCatapult = true;
        break;
      }
    }

    // Se não encontrou tipo específico, procurar pelo ícone de comando principal
    if (!icon_src || type === 'Ataque') {
      for (const icon of iconData) {
        const urlLower = icon.src.toLowerCase();
        const normalizedKey = normalizeIconKeyFromURL(icon.src);

        if (urlLower.includes('/graphic/command/attack')) {
          icon_key = normalizedKey;
          icon_src = icon.src;
          icon_alt = icon.alt || icon.title || '';

          if (normalizedKey.includes('attack_small')) {
            type = 'Ataque (Small)';
          } else if (normalizedKey.includes('attack_medium')) {
            type = 'Ataque (Medium)';
          } else if (normalizedKey.includes('attack_large')) {
            type = 'Ataque (Large)';
          } else {
            type = 'Ataque';
          }
          break;
        }

        if (urlLower.includes('/graphic/command/support') || normalizedKey.includes('support')) {
          type = 'Apoio';
          icon_key = normalizedKey;
          icon_src = icon.src;
          icon_alt = icon.alt || icon.title || '';
          break;
        }
      }
    }

    // Se ainda não encontrou icon_src, usar o primeiro ícone encontrado
    if (!icon_src && iconData.length > 0) {
      icon_src = iconData[0].src;
      icon_key = normalizeIconKeyFromURL(icon_src);
      icon_alt = iconData[0].alt || iconData[0].title || '';
    }

    return { type, icon_key, icon_src, icon_alt, isNoble, isRam, isCatapult };
  }

  function extractCommandId(td){
    try{
      const strategies=[
        () => td.querySelector('input[name^="command_ids["], input[name^="id_"], input[name="id[]"], input[name^="commands["], input[name^="select_attack_"]'),
        () => td.closest('.quickedit'),
        () => td.querySelector('.quickedit, [data-id]'),
        () => td.querySelector('a[href*="info_command"]')
      ];
      for(const strategy of strategies){
        const el=strategy(); if(!el) continue;
        if(el.tagName==='INPUT'){
          const name=el.getAttribute('name')||''; const value=el.getAttribute('value')||'';
          const match=name.match(/\[(\d+)\]|id_(\d+)/);
          if (match) return match[1]||match[2];
          if(/^\d+$/.test(value)) return value;
        }
        const dataId=el.getAttribute?.('data-id');
        if (dataId && /^\d+$/.test(dataId)) return dataId;
        if (el.href){
          const idParam=new URL(el.href,location.origin).searchParams.get('id');
          if(idParam && /^\d+$/.test(idParam)) return idParam;
        }
      }
      return null;
    }catch{ return null; }
  }

  function parseArrivalAbsolute(input){
    try {
      if (typeof input === 'number') return input;
      if (!input) return 0;

      // Se for string numérica exata (timestamp como string)
      if (typeof input === 'string' && /^\d+$/.test(input.trim())) {
          return Number(input);
      }

      // 1. Limpeza agressiva do texto (mantém dígitos, dois pontos, ponto, vírgula, traço e letras)
      const raw = (input?.textContent || input || '').toString();
      const clean = raw.replace(/[^\d:., \-a-zA-Z]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

      // 2. Regex Universal: Aceita HH:MM:SS seguido de qualquer separador (ou nenhum) e 3 dígitos
      // Aceita: "14:20:05:123", "14:20:05.123", "14:20:05,123", "14:20:05 123"
      const timeMatch = clean.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,:\s]*(\d{3}))?/);

      if (!timeMatch) {
          // Se falhou, tenta formato ISO direto
          const ts = Date.parse(raw);
          return isNaN(ts) ? 0 : ts;
      }

      const H = parseInt(timeMatch[1]);
      const M = parseInt(timeMatch[2]);
      const S = parseInt(timeMatch[3] || 0); // Segundos podem ser opcionais em alguns contextos
      const MS = timeMatch[4] ? parseInt(timeMatch[4]) : 0; // Captura os milissegundos

      // DEBUG CRÍTICO: Se tiver milissegundos, avisa no console (remover depois)
      // if (MS > 0 && Math.random() < 0.01) console.log('✅ MS Detectado:', MS, 'em:', clean);

      const now = new Date();
      const base = new Date(now);

      // Ajuste de data (hoje, amanhã, dia/mês)
      if (clean.includes('amanh')) base.setDate(base.getDate() + 1);
      else if (clean.includes('ontem')) base.setDate(base.getDate() - 1);
      else {
          const dateMatch = clean.match(/(\d{1,2})[\/.](\d{1,2})/);
          if (dateMatch) {
              base.setMonth(parseInt(dateMatch[2]) - 1);
              base.setDate(parseInt(dateMatch[1]));
              if (base.getTime() < now.getTime() - 24*60*60*1000 * 300) base.setFullYear(base.getFullYear() + 1);
          }
      }

      base.setHours(H, M, S, MS);

      // Correção de virada de dia se não tiver data explícita
      if (!clean.includes('hoje') && !clean.includes('amanh') && !clean.includes('ontem') && !/\d+\/\d+/.test(clean)) {
          // Se o horário calculado já passou há mais de 1 minuto, assume que é amanhã
          if (base.getTime() < now.getTime() - 60000) {
             base.setDate(base.getDate() + 1);
          }
      }

      return base.getTime();
    } catch (e) {
      // console.log('Erro data:', e);
      return 0;
    }
  }

  function parseEtaToMs(s){
    if (!s) return null;
    const t = s.replace(/\s+/g,' ').trim().toLowerCase();
    let m = t.match(/^(\d+):(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) { const d=+m[1],h=+m[2],mi=+m[3],se=+m[4]; return (((d*24+h)*60+mi)*60+se)*1000; }
    m = t.match(/^(\d+)\s*d[a-z]*\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) { const d=+m[1],h=+m[2],mi=+m[3],se=+m[4]; return (((d*24+h)*60+mi)*60+se)*1000; }
    m = t.match(/^(\d+)\s*dias?\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) { const d=+m[1],h=+m[2],mi=+m[3],se=+m[4]; return (((d*24+h)*60+mi)*60+se)*1000; }
    m = t.match(/^(\d+):(\d{2}):(\d{2})$/);
    if (m) { const h=+m[1],mi=+m[2],se=+m[3]; return ((h*60+mi)*60+se)*1000; }
    return null;
  }

  function hashNumericId(s){ try{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h*=16777619;}h=Math.abs(h);return Number(String(h).padStart(10,'0'));}catch{ return Date.now(); } }
  function normalizeOriginKey(origin){ return (origin||'').toLowerCase().replace(/\s+/g,' ').trim(); }
  function hasRealSize(a){ const sz=(a.axe_size||'').toLowerCase(); return sz==='small'||sz==='medium'||sz==='large'; }

  function applyProvisionalByOrigin(attacks){
    try{
      const now = Date.now();
      const byOrigin = new Map();
      attacks.forEach(a=>{
        const ok = normalizeOriginKey(a.origin);
        if (!byOrigin.has(ok)) byOrigin.set(ok, []);
        byOrigin.get(ok).push(a);
      });
      byOrigin.forEach(list=>{
        const future = list.filter(a=> (a.arrival_at||0) > now && !isSupport(a));
        const hasLarge = future.some(isLargeConfirmed);
        if (!hasLarge) return;
        const ref = future.find(isLargeConfirmed);
        future.forEach(a=>{
          if (a===ref) return;
          if (hasRealSize(a)) return;
          a.provisional = true;
          a.provisional_kind = 'small_medium';
          a.provisional_reason = 'origin_has_large';
          a.provisional_origin_key = normalizeOriginKey(a.origin);
          a.provisional_ref = ref?.command_id || '';
          if ((a.axe_size||'').toLowerCase()!=='small_medium'){
            a.axe_size = 'small_medium';
          }
        });
      });
      return attacks;
    }catch(e){
      dlog('applyProvisionalByOrigin erro:', e);
      return attacks;
    }
  }

  function isIncomingsPage(){
    // Verificar URL primeiro (mais confiável)
    const url = new URL(location.href);
    if (url.searchParams.get('screen') === 'overview_villages' && url.searchParams.get('mode') === 'incomings') {
      return true;
    }
    // Fallback: verificar se a tabela está presente no DOM
    return !!document.querySelector(cfg.selectors.incomingTable);
  }

  function isCommandsPage(){
    // Verificar se está na página de comandos enviados
    const url = new URL(location.href);
    if (url.searchParams.get('screen') === 'overview_villages' && url.searchParams.get('mode') === 'commands') {
      return true;
    }
    // Verificar se a tabela de comandos está presente
    const tableSelectors = ['#commands_table', '#overview_table', 'table.commands_table'];
    for (const selector of tableSelectors) {
      if (document.querySelector(selector)) return true;
    }
    return false;
  }

  // Função para detectar se há mais páginas disponíveis através dos elementos de paginação no DOM
  function detectMorePagesFromPagination(mode = 'incomings', type = 'unignored') {
    try {
      // Verificar página atual na URL primeiro
      const url = new URL(location.href);
      const currentPageParam = url.searchParams.get('page');
      let currentPage = 0;
      if (currentPageParam !== null) {
        currentPage = parseInt(currentPageParam);
      }

      // Buscar o container de paginação - procurar especificamente por td que contém paged-nav-item
      let paginationContainer = null;

      // Primeiro: procurar por td que contém links paged-nav-item (mais específico)
      const allTds = document.querySelectorAll('td[align="center"]');
      for (const td of allTds) {
        if (td.querySelector('a.paged-nav-item')) {
          paginationContainer = td;
          break;
        }
      }

      // Se não encontrou, tentar outros seletores
      if (!paginationContainer) {
        paginationContainer = document.querySelector('.paged-nav, .pagination');
        if (!paginationContainer) {
          // Buscar qualquer td que contenha links com page= e strong (página atual)
          for (const td of document.querySelectorAll('td')) {
            if (td.querySelector('a[href*="page="]') && td.querySelector('strong')) {
              paginationContainer = td;
              break;
            }
          }
        }
      }

      // Buscar TODOS os links que contenham page= (não apenas paged-nav-item)
      const allPageLinks = paginationContainer
        ? paginationContainer.querySelectorAll('a[href*="page="]')
        : document.querySelectorAll('a[href*="page="]');

      let maxPageFound = -1;
      const pageNumbers = new Set();

      // Analisar todos os links encontrados
      allPageLinks.forEach(link => {
        try {
          const href = link.getAttribute('href') || link.href || '';
          // Procurar page= no href
          const pageMatch = href.match(/[?&]page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            pageNumbers.add(pageNum);
            if (pageNum > maxPageFound) {
              maxPageFound = pageNum;
            }
          }
        } catch (e) {
          // Ignorar erros
        }
      });

      // Verificar qual página está destacada (strong ou span com classe active)
      if (paginationContainer) {
        const currentPageStrong = paginationContainer.querySelector('strong');
        if (currentPageStrong) {
          const strongText = currentPageStrong.textContent.trim();
          const pageMatch = strongText.match(/(\d+)/);
          if (pageMatch) {
            const pageFromStrong = parseInt(pageMatch[1]) - 1; // Converter para 0-based
            if (pageFromStrong >= 0) {
              currentPage = pageFromStrong;
            }
          }
        }

        // Tentar encontrar página atual por classe active ou similar
        const activeLink = paginationContainer.querySelector('a.active, strong, span.active');
        if (activeLink) {
          const activeText = activeLink.textContent.trim();
          const pageMatch = activeText.match(/(\d+)/);
          if (pageMatch) {
            const pageFromActive = parseInt(pageMatch[1]) - 1;
            if (pageFromActive >= 0) {
              currentPage = pageFromActive;
            }
          }
        }
      }

      // Se encontrou páginas maiores que a atual, há mais páginas
      const hasMore = maxPageFound >= 0 && maxPageFound > currentPage;

      return {
        hasMore: hasMore,
        maxPage: maxPageFound >= 0 ? maxPageFound : currentPage,
        currentPage: currentPage,
        method: hasMore ? 'pagination_links' : (maxPageFound === -1 ? 'no_links_found' : 'no_more_pages')
      };
    } catch (e) {
      return { hasMore: false, maxPage: 0, currentPage: 0, method: 'error' };
    }
  }

  // Função para detectar se há mais páginas de comandos enviados através dos elementos de paginação
  function detectMorePagesCommandsFromPagination() {
    try {
      // Verificar página atual na URL primeiro
      const url = new URL(location.href);
      const currentPageParam = url.searchParams.get('page');
      let currentPage = 0;
      if (currentPageParam !== null) {
        currentPage = parseInt(currentPageParam);
      }

      // Buscar o container de paginação - procurar especificamente por td que contém paged-nav-item
      let paginationContainer = null;

      // Primeiro: procurar por td que contém links paged-nav-item (mais específico)
      const allTds = document.querySelectorAll('td[align="center"]');
      for (const td of allTds) {
        if (td.querySelector('a.paged-nav-item')) {
          paginationContainer = td;
          break;
        }
      }

      // Se não encontrou, tentar outros seletores
      if (!paginationContainer) {
        paginationContainer = document.querySelector('.paged-nav, .pagination');
        if (!paginationContainer) {
          // Buscar qualquer td que contenha links com page= e strong (página atual)
          for (const td of document.querySelectorAll('td')) {
            if (td.querySelector('a[href*="page="]') && td.querySelector('strong')) {
              paginationContainer = td;
              break;
            }
          }
        }
      }

      if (!paginationContainer) {
        return { hasMore: false, maxPage: 0, currentPage: currentPage, method: 'no_container' };
      }

      // Buscar todos os links com page= para encontrar o maior número (ignorar page=-1)
      const allPageLinks = paginationContainer.querySelectorAll('a[href*="page="]');
      let maxPageFound = currentPage;

      allPageLinks.forEach(link => {
        try {
          const href = link.getAttribute('href') || link.href || '';
          const pageMatch = href.match(/[?&]page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            // Ignorar page=-1 (todos) e considerar apenas números >= 0
            if (pageNum >= 0 && pageNum > maxPageFound) {
              maxPageFound = pageNum;
            }
          }
        } catch (e) {}
      });

      // Verificar página atual destacada (strong)
      const currentPageStrong = paginationContainer.querySelector('strong');
      if (currentPageStrong) {
        const strongText = currentPageStrong.textContent.trim();
        const pageMatch = strongText.match(/(\d+)/);
        if (pageMatch) {
          const pageFromStrong = parseInt(pageMatch[1]) - 1; // Converter para 0-based
          if (pageFromStrong >= 0) {
            currentPage = pageFromStrong;
          }
        }
      }

      const hasMore = maxPageFound > currentPage;

      return {
        hasMore: hasMore,
        maxPage: maxPageFound,
        currentPage: currentPage,
        method: hasMore ? 'pagination_detected' : 'no_more_pages'
      };
    } catch (e) {
      return { hasMore: false, maxPage: 0, currentPage: 0, method: 'error' };
    }
  }

  // Função para detectar se há mais páginas de ignorados através dos elementos de paginação
  function detectMorePagesIgnoredFromPagination() {
    try {
      // Procurar pelo elemento de paginação (td com links paged-nav-item)
      const paginationTd = document.querySelector('td[align="center"]');
      if (!paginationTd) {
        return { hasMore: false, maxPage: 0, currentPage: 0, method: 'no_pagination_element' };
      }

      // Procurar todos os links de paginação
      const pageLinks = paginationTd.querySelectorAll('a.paged-nav-item[href*="page="]');
      let maxPageFound = -1;
      let currentPage = 0;

      // Verificar página atual na URL
      const url = new URL(location.href);
      const currentPageParam = url.searchParams.get('page');
      if (currentPageParam !== null) {
        currentPage = parseInt(currentPageParam);
      }

      // Verificar se está na página "todos" (strong com "todos")
      const currentPageStrong = paginationTd.querySelector('strong');
      if (currentPageStrong) {
        const strongText = currentPageStrong.textContent.trim();
        if (strongText.includes('todos')) {
          // Se está em "todos", não há mais páginas
          return { hasMore: false, maxPage: 0, currentPage: -1, method: 'all_pages' };
        }
        const pageMatch = strongText.match(/>(\d+)</);
        if (pageMatch) {
          currentPage = parseInt(pageMatch[1]) - 1; // Converter para 0-based
        }
      }

      // Analisar todos os links de paginação
      pageLinks.forEach(link => {
        try {
          const href = link.getAttribute('href') || '';
          const pageMatch = href.match(/[?&]page=(\d+)/);
          if (pageMatch) {
            const pageNum = parseInt(pageMatch[1]);
            if (pageNum > maxPageFound) {
              maxPageFound = pageNum;
            }
          }
        } catch (e) {
          // Ignorar erros
        }
      });

      // Se encontrou páginas maiores que a atual, há mais páginas
      const hasMore = maxPageFound > currentPage;

      return {
        hasMore: hasMore,
        maxPage: maxPageFound,
        currentPage: currentPage,
        method: hasMore ? 'pagination_links' : 'no_more_pages'
      };
    } catch (e) {
      dlog('Erro ao detectar páginas da paginação (ignored):', e);
      return { hasMore: false, maxPage: 0, currentPage: 0, method: 'error' };
    }
  }

  function buildIncomingsURL(page = null) {
    try {
      // Construir URL para TODAS as aldeias (sem village específico)
      const incomingsUrl = new URL(location.origin + location.pathname);
      incomingsUrl.searchParams.set('screen', 'overview_villages');
      incomingsUrl.searchParams.set('mode', 'incomings');
      // Preservar o grupo da URL atual, se existir
      // IMPORTANTE: Não adicionar group=0 se não existir na URL atual
      // Isso evita forçar o grupo "todos" quando a página ainda não carregou completamente
      const currentGroup = new URLSearchParams(location.search).get('group');
      if (currentGroup !== null) {
        incomingsUrl.searchParams.set('group', currentGroup);
      }
      // Remover village específico para pegar TODAS as aldeias
      incomingsUrl.searchParams.delete('village');
      if (page !== null) {
        incomingsUrl.searchParams.set('page', String(page));
      }

      return incomingsUrl.toString();
    } catch (e) {
      dlog('Erro ao construir URL de incomings:', e);
      return null;
    }
  }

  // Função para coletar ataques de páginas específicas (usado quando página está aberta)
  async function collectAttacksFromPages(startPage, endPage) {
    const allAttacks = [];
    try {
      let emptyStreak = 0;
      for (let page = startPage; page <= endPage; page++) {
        const url = buildIncomingsURL(page);
        if (!url) break;

        const response = await rateLimitFetch(url, {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });

        if (!response.ok) break;

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // Detectar se a página TEM alguma linha de comando na tabela
        const hasAnyRow = !!doc.querySelector('#incomings_table input[name^=\"command_ids[\"], #incomings_table [data-command-id]');
        if (!hasAnyRow) {
          emptyStreak++;
          dlog(`✅ [Attacks] Página ${page}: nenhuma linha de comando encontrada (emptyStreak=${emptyStreak})`);
          if (emptyStreak >= 2) {
            dlog('✅ [Attacks] Duas páginas vazias seguidas. Encerrando varredura (coleta páginas específicas).');
            break;
          }
          continue;
        }

        // Página tem linhas → coletar normalmente
        const attacks = collectAttacksFromDocument(doc);
        if (attacks.length > 0) {
          emptyStreak = 0;
          allAttacks.push(...attacks);
          dlog(`📄 [Attacks] Página ${page}: ${attacks.length} comandos coletados (total: ${allAttacks.length})`);
        } else {
          dlog(`⚠️ [Attacks] Página ${page} tem linhas mas nenhuma passou no filtro (pode ser tudo passado/ignorado).`);
        }

        // Pequeno delay entre páginas para não sobrecarregar (800ms evita lag na main thread)
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      return allAttacks;
    } catch (e) {
      dlog('❌ [Attacks] Erro ao coletar ataques de páginas específicas:', e);
      return allAttacks;
    }
  }

  // Função para coletar ataques de TODAS as páginas, respeitando a paginação real do jogo
  async function collectAttacksFromAllPages() {
    const allAttacks = [];
    try {
      dlog('🔍 [Attacks] Navegando por páginas individuais (com maxPage dinâmico)...');
      let emptyStreak = 0;
      let maxPageDetected = null;

      for (let page = 0; page < 50; page++) { // limite de segurança
        if (maxPageDetected !== null && page > maxPageDetected) break;

        const url = buildIncomingsURL(page);
        if (!url) break;

        const response = await rateLimitFetch(url, {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });

        if (!response.ok) break;

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // Na primeira página, detectar o número máximo de páginas reais via paginação
        if (page === 0) {
          let paginationContainer = null;
          const allTds = doc.querySelectorAll('td[align=\"center\"]');
          for (const td of allTds) {
            if (td.querySelector('a.paged-nav-item, a[href*=\"page=\"]')) {
              paginationContainer = td;
              break;
            }
          }
          if (!paginationContainer) {
            paginationContainer = doc.querySelector('.paged-nav, .pagination');
          }
          let maxPage = 0;
          if (paginationContainer) {
            const links = paginationContainer.querySelectorAll('a[href*=\"page=\"]');
            links.forEach(link => {
              const href = link.getAttribute('href') || link.href || '';
              const m = href.match(/[?&]page=(\d+)/);
              if (m) {
                const num = parseInt(m[1], 10);
                if (!Number.isNaN(num) && num > maxPage) {
                  maxPage = num;
                }
              }
            });
          }
          maxPageDetected = maxPage;
          dlog(`🔎 [Attacks] maxPageDetectado pelo DOM: ${maxPageDetected}`);
        }

        // Detectar se a página TEM alguma linha de comando na tabela
        const hasAnyRow = !!doc.querySelector('#incomings_table input[name^=\"command_ids[\"], #incomings_table [data-command-id]');
        if (!hasAnyRow) {
          emptyStreak++;
          dlog(`✅ [Attacks] Página ${page}: nenhuma linha de comando encontrada (emptyStreak=${emptyStreak})`);
          if (emptyStreak >= 2) {
            dlog('✅ [Attacks] Duas páginas vazias seguidas. Encerrando varredura (todas as páginas).');
            break;
          }
          continue;
        }

        // Página tem linhas → coletar normalmente
        const attacks = collectAttacksFromDocument(doc);
        if (attacks.length > 0) {
          emptyStreak = 0;
          allAttacks.push(...attacks);
          dlog(`📄 [Attacks] Página ${page}: ${attacks.length} comandos coletados (total: ${allAttacks.length})`);
        } else {
          dlog(`⚠️ [Attacks] Página ${page} tem linhas mas nenhuma passou no filtro (pode ser tudo passado/ignorado).`);
        }

        await new Promise(resolve => setTimeout(resolve, 800));
      }

      dlog(`✅ [Attacks] Total coletado de todas as páginas: ${allAttacks.length} comandos`);
      return allAttacks;
    } catch (e) {
      dlog('❌ [Attacks] Erro ao coletar ataques de múltiplas páginas:', e);
      return allAttacks; // Retornar o que conseguiu coletar
    }
  }

  // ===== FUNÇÕES PARA COMANDOS ENVIADOS =====
  function buildCommandsURL(page = null) {
    try {
      const commandsUrl = new URL(location.origin + location.pathname);
      commandsUrl.searchParams.set('screen', 'overview_villages');
      commandsUrl.searchParams.set('mode', 'commands');
      commandsUrl.searchParams.set('type', 'attack');
      // Preservar o grupo da URL atual, se existir
      // IMPORTANTE: Não adicionar group=0 se não existir na URL atual
      // Isso evita forçar o grupo "todos" quando a página ainda não carregou completamente
      const currentGroup = new URLSearchParams(location.search).get('group');
      if (currentGroup !== null) {
        commandsUrl.searchParams.set('group', currentGroup);
      }
      commandsUrl.searchParams.delete('village');
      if (page !== null) {
        commandsUrl.searchParams.set('page', String(page));
      }
      return commandsUrl.toString();
    } catch (e) {
      dlog('Erro ao construir URL de comandos enviados:', e);
      return null;
    }
  }

  // Função para coletar comandos de páginas específicas (usado quando página está aberta)
  async function collectCommandsFromPages(startPage, endPage) {
    const allCommands = [];
    let previousPageCommandIds = null;
    try {
      for (let page = startPage; page <= endPage; page++) {
        const url = buildCommandsURL(page);
        if (!url) break;

        const response = await rateLimitFetch(url, {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });

        if (!response.ok) break;

          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const commands = collectCommandsFromDocument(doc);

        // Se página está vazia (0 comandos), é o fim definitivo
        if (commands.length === 0) {
          dlog(`✅ [Commands] Página ${page}: nenhum comando encontrado, fim das páginas`);
          break;
        }

        // Detectar se está repetindo a última página válida
        const currentPageCommandIds = commands.map(cmd => cmd.command_id || '').filter(id => id).join(',');

        if (previousPageCommandIds !== null && currentPageCommandIds === previousPageCommandIds) {
          dlog(`✅ [Commands] Página ${page}: detectada repetição da última página válida (página ${page - 1}), fim das páginas`);
          break;
        }

        previousPageCommandIds = currentPageCommandIds;
        allCommands.push(...commands);
        dlog(`📄 [Commands] Página ${page}: ${commands.length} comandos coletados (total: ${allCommands.length})`);

        await new Promise(resolve => setTimeout(resolve, 800));
      }
      return allCommands;
    } catch (e) {
      dlog('❌ [Commands] Erro ao coletar comandos de páginas específicas:', e);
      return allCommands;
        }
      }

  // Função para coletar comandos de TODAS as páginas
  async function collectCommandsFromAllPages() {
    const allCommands = [];
    let previousPageCommandIds = null; // Para detectar repetição da última página válida
    try {
      // Para comandos enviados, começar direto em page=0 (não tenta page=-1)
      dlog('🔍 [Commands] Navegando por páginas individuais...');
      for (let page = 0; page < 50; page++) { // Máximo 50 páginas (50.000 comandos)
        const url = buildCommandsURL(page);
        if (!url) break;

        const response = await rateLimitFetch(url, {
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });

        if (!response.ok) break;

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const commands = collectCommandsFromDocument(doc);

        // Se página está vazia (0 comandos), é o fim definitivo
        if (commands.length === 0) {
          dlog(`✅ [Commands] Página ${page}: nenhum comando encontrado, fim das páginas`);
          break; // Página vazia = fim definitivo
        }

        // Detectar se está repetindo a última página válida
        // O jogo retorna sempre a última página quando solicitamos páginas inexistentes
        const currentPageCommandIds = commands.map(cmd => cmd.command_id || '').filter(id => id).join(',');

        if (previousPageCommandIds !== null && currentPageCommandIds === previousPageCommandIds) {
          // Página atual é idêntica à anterior = estamos repetindo a última página válida
          dlog(`✅ [Commands] Página ${page}: detectada repetição da última página válida (página ${page - 1}), fim das páginas`);
          break;
        }

        previousPageCommandIds = currentPageCommandIds;
        allCommands.push(...commands);
        dlog(`📄 [Commands] Página ${page}: ${commands.length} comandos coletados (total: ${allCommands.length})`);

        // Pequeno delay entre páginas para não sobrecarregar (800ms evita lag na main thread)
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      dlog(`✅ [Commands] Total coletado de todas as páginas: ${allCommands.length} comandos`);
      return allCommands;
    } catch (e) {
      dlog('❌ [Commands] Erro ao coletar comandos de múltiplas páginas:', e);
      return allCommands; // Retornar o que conseguiu coletar
    }
  }

  function parseArrivalTimeCommands(text) {
    if (!text) return null;

    // Normalizar "hoje às" para "hoje"
    text = text.replace(/\bàs\s+/gi, ' ').trim();

    // Usar diretamente a função principal que agora é robusta
    const absoluteTime = parseArrivalAbsolute(text);
    return absoluteTime || null;

    return null;
  }

  function extractCommandIdCommands(element) {
    try {
      const span = element.querySelector('span[data-command-id]');
      if (span) {
        const id = span.getAttribute('data-command-id');
        if (id && /^\d+$/.test(id)) return id;
      }
      const link = element.querySelector('a[href*="command_id="]');
      if (link) {
        const match = link.href.match(/command_id=(\d+)/);
        if (match) return match[1];
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function collectCommandsFromDocument(doc) {
    try {
      if (cfg.debug) {
        dlog('🔍 [Commands] Iniciando coleta de comandos enviados...');
        dlog('🔍 [Commands] Documento recebido:', doc ? 'OK' : 'NULL');
        dlog('🔍 [Commands] URL do documento:', doc?.URL || doc?.location?.href || 'N/A');
      }

      const tableSelectors = ['#commands_table', '#overview_table', 'table.commands_table', 'table.vis'];
      let table = null;
      for (const selector of tableSelectors) {
        table = doc.querySelector(selector);
        if (table) {
          if (cfg.debug) dlog(`✅ [Commands] Tabela encontrada com seletor: ${selector}`);
          break;
        }
      }
      if (!table) {
        if (cfg.debug) dlog('⚠️ [Commands] Tabela não encontrada com seletores padrão, tentando busca genérica...');
        const allTables = doc.querySelectorAll('table.vis, table');
        if (cfg.debug) dlog(`🔍 [Commands] Encontradas ${allTables.length} tabelas no documento`);
        for (const t of allTables) {
          const rows = t.querySelectorAll('tbody tr, tr');
          if (rows.length > 0) {
            const firstRow = rows[0];
            const cells = firstRow.querySelectorAll('td, th');
            if (cells.length >= 5) {
              table = t;
              if (cfg.debug) dlog(`✅ [Commands] Tabela encontrada com ${rows.length} linhas e ${cells.length} colunas`);
              break;
            }
          }
        }
      }
      if (!table) {
        if (cfg.debug) dlog('❌ [Commands] Tabela não encontrada - nenhuma tabela válida no documento');
        return [];
      }
      const rows = table.querySelectorAll('tbody tr, tr:has(td)');
      if (cfg.debug) dlog(`🔍 [Commands] Processando ${rows.length} linhas da tabela`);
      const list = [];
      const now = Date.now();
      const loggedPlayer = getLoggedPlayerName();
      if (cfg.debug) dlog(`👤 [Commands] Jogador logado: ${loggedPlayer || 'NÃO ENCONTRADO'}`);
      rows.forEach((tr, index) => {
        try {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 5) {
            if (cfg.debug && index < 3) dlog(`  ⚠️ [Commands] Linha ${index + 1}: Menos de 5 células, pulando...`);
            return;
          }

          // Para comandos ENVIADOS, a estrutura é diferente:
          // Célula 0: Target (aldeia de destino) - "Ataque a 0049..."
          // Célula 1: Origin (aldeia de origem) - "0021 - A P O S E N T A D O S..."
          // Célula 2: Arrival Time - "hoje às 01:30:27:996"
          const tdCmd = tds[0];
          const tdTarget = tds[0];
          const tdOrigin = tds[1];
          const tdDefender = null;
          const tdArrival = tds[2];

          // Detectar tipo de comando analisando TODOS os ícones na célula
          const commandTypeInfo = detectCommandTypeFromIcons(tdCmd);
          const type = commandTypeInfo.type;
          const icon_key = commandTypeInfo.icon_key;
          const icon_src = commandTypeInfo.icon_src;
          const icon_alt = commandTypeInfo.icon_alt;

          // Extrair target da célula 0 (formato: "Ataque a 0049 (553|514) K55" ou "Ataque a 0017 - A P O S E N T A D O S (553|519) K5")
          let target = (tdTarget?.textContent || '').replace(/\s+/g, ' ').trim();
          const targetMatch = target.match(/Ataque a\s+(.+)/i);
          if (targetMatch) {
            target = targetMatch[1].trim();
          }

          // Origin está na célula 1
          const origin = (tdOrigin?.textContent || '').replace(/\s+/g, ' ').trim();

          // Defender não existe em comandos enviados (é sempre o próprio jogador)
          const defender = loggedPlayer || 'Desconhecido';

          // Arrival está na célula 2
          const arrivalText = (tdArrival?.textContent || '').replace(/\s+/g, ' ').trim();

          if (!target || !origin) {
            if (cfg.debug && index < 3) dlog(`  ⚠️ [Commands] Linha ${index + 1}: target ou origin vazio`);
            return;
          }

          let arrival_at = parseArrivalTimeCommands(arrivalText);
          if (!arrival_at) {
            if (cfg.debug && index < 3) dlog(`  ⚠️ [Commands] Linha ${index + 1}: não foi possível parsear horário`);
            return;
          }
          if (arrival_at <= now) {
            if (cfg.debug && index < 3) dlog(`  ⚠️ [Commands] Linha ${index + 1}: comando já chegou`);
            return;
          }

          let command_id = extractCommandIdCommands(tdCmd);
          if (!command_id || !/^\d+$/.test(command_id)) {
            const hashInput = origin.toLowerCase() + '|' + target.toLowerCase() + '|' + Math.floor(arrival_at / 1000);
            command_id = String(Math.abs(hashInput.split('').reduce((a, b) => {
              a = ((a << 5) - a) + b.charCodeAt(0);
              return a & a;
            }, 0)));
          }

          const watchtower = /torre\s*de\s*vigia|watchtower/i.test(tdCmd.textContent || '');

          // Detectar tamanho do machado
          let axe_size = 'unknown';
          const typeLower = (type || '').toLowerCase();
          if (typeLower.includes('small')) {
            axe_size = 'small';
          } else if (typeLower.includes('medium')) {
            axe_size = 'medium';
          } else if (typeLower.includes('large')) {
            axe_size = 'large';
          } else {
            axe_size = detectAxeSizeFromKey(icon_key);
          }

          const commandData = {
            command_id: String(command_id),
            type: type,
            target: target,
            defender: defender || 'Desconhecido',
            origin: origin,
            attacker: loggedPlayer,
            player: loggedPlayer,
            distance: '',
            arrival_text: arrivalText,
            arrival_at: arrival_at,
            captured_at: now,
            source: 'local',
            icon_key: icon_key,
            icon_src: icon_src,
            icon_alt: icon_alt,
            axe_size: axe_size,
            watchtower: watchtower
          };

          list.push(commandData);
        } catch (e) {
          if (cfg.debug) dlog(`  ❌ [Commands] Erro ao processar linha ${index + 1}:`, e);
        }
      });
      if (cfg.debug) dlog(`📋 [Commands] Total coletado: ${list.length} comandos enviados válidos`);
      return list;
    } catch (e) {
      dlog('[Commands] Erro ao coletar comandos enviados:', e);
      return [];
    }
  }

  function collectAttacksFromDocument(doc) {
    try{
      const table = doc.querySelector(cfg.selectors.incomingTable);
      if(!table){ return []; }
      const rows = table.querySelectorAll(cfg.selectors.rows);
      const list = []; const now = Date.now();

      rows.forEach((tr) => {
        try{
          const tds = tr.querySelectorAll('td');
          if(tds.length < 7) return;

          const tdCmd = tds[0], tdTgt = tds[1], tdOrg = tds[2], tdPly = tds[3], tdDist = tds[4], tdArriv = tds[5], tdETA = tds[6];

          const type = (function(td){
            const sels = ['.quickedit-label','.quickedit span','td:first-child span','span[class*="icon"]','img[src*="command"]'];
            for(const sel of sels){
              const el = td.querySelector(sel);
              if(el){
                const text = el.textContent?.trim();
                if(text && text !== '&nbsp;') return text;
                if(el.tagName === 'IMG'){
                  const src = el.src || '';
                  if(src.includes('attack')) return 'Ataque';
                  if(src.includes('support')) return 'Apoio';
                  if(src.includes('other')) return 'Outro';
                }
              }
            }
            const cellText = (td?.textContent || '').replace(/\s+/g,' ').trim();
            if(cellText) return cellText.split(' ')[0] || 'Comando';
            return 'Comando';
          })(tdCmd);

          const target = (tdTgt?.textContent || '').replace(/\s+/g,' ').trim();
          const origin = (tdOrg?.textContent || '').replace(/\s+/g,' ').trim();
          const attacker = (tdPly?.textContent || '').replace(/\s+/g,' ').trim();
          const distance = (tdDist?.textContent || '').replace(/\s+/g,' ').trim();

          // Obter nome do jogador: priorizar página de aldeia, depois getLoggedPlayerName
          let defender = '';
          if (isVillageInfoPage()) {
            // CRÍTICO: Quando na página de aldeia, SEMPRE usar getPlayerNameFromVillagePage()
            // NUNCA usar getLoggedPlayerName() como fallback pois pode retornar nome de conta em férias
            const villageName = getPlayerNameFromVillagePage();
            if (villageName) {
              defender = villageName;
              // IMPORTANTE: Atualizar cache global (mas não sobrescrever se já temos um nome válido diferente)
              // O cache por aldeia já foi atualizado dentro de getPlayerNameFromVillagePage()
              if (cfg.debug) {
                dlog(`[collectAttacksFromDocument] ✅ Defender obtido da página de aldeia: ${defender}`);
              }
            } else {
              // Se não conseguir detectar na página, usar cache por aldeia se disponível
              const villageCoords = getVillageCoordsFromURL();
              const villageKey = villageCoords ? `${villageCoords.x}|${villageCoords.y}` : null;
              if (villageKey && __villagePlayerNameCache && __villagePlayerNameCache.has(villageKey)) {
                defender = __villagePlayerNameCache.get(villageKey);
                if (cfg.debug) dlog(`[collectAttacksFromDocument] ✅ Defender do cache da aldeia ${villageKey}: ${defender}`);
              } else {
                // Último recurso: usar cache global (mas avisar que pode estar errado)
                defender = __cachedPlayerName || '';
                if (cfg.debug && defender) {
                  dlog(`[collectAttacksFromDocument] ⚠️ Usando cache global (pode estar incorreto em modo de férias): ${defender}`);
                }
              }
            }
          } else {
            // Quando não está na página de aldeia, usar cache atualizado ou getLoggedPlayerName
            defender = __cachedPlayerName || getLoggedPlayerName() || '';
            if (cfg.debug && __cachedPlayerName && __cachedPlayerName !== 'Jogador Desconhecido') {
              dlog(`[collectAttacksFromDocument] Usando nome do cache: ${defender}`);
            }
          }
          // Normalizar o defender para garantir encoding correto
          defender = normalizeName(defender);

          const arrivalText = (tdArriv?.textContent || '').replace(/\s+/g,' ').trim();

          // --- CORREÇÃO PRINCIPAL AQUI ---
          // 1. Tenta ler a data absoluta COM milissegundos
          let arrival_at = parseArrivalAbsolute(tdArriv);

          // 2. Se falhar (retornar 0 ou null), usa o ETA como fallback
          if (!arrival_at) {
             const etaText = (tdETA?.textContent || '').replace(/\s+/g,' ').trim();
             const etaMs = parseEtaToMs(etaText);
             if (etaMs != null) {
                 arrival_at = now + etaMs;
             }
          }
          // REMOVIDO: O bloco "else if" que sobrescrevia arrival_at se a diferença fosse > 30s.
          // Confiamos mais na leitura direta da tabela (que agora suporta milissegundos)
          // do que no cálculo ETA + Relógio do Cliente (que é impreciso).

          if ((arrival_at || 0) <= now) return;

          let command_id = extractCommandId(tdCmd);
          if (!/^\d+$/.test(String(command_id || ''))) {
            const hashInput = origin.toLowerCase() + '|' + target.toLowerCase() + '|' + Math.floor(arrival_at / 1000);
            command_id = hashNumericId(hashInput);
          }

          const span = tdCmd.querySelector('span[data-command-id], span[class*="commandicon"]');
          const spanTitle = (span?.getAttribute('data-title') || span?.getAttribute('title') || '').trim();
          const watchtower = (span && span.classList.contains('commandicon-wt')) || /torre\s*de\s*vigia|watchtower|será\s*detectado\s*por\s*uma\s*torre/i.test(spanTitle);

          let img = tdCmd.querySelector('img[src*="/graphic/command/attack"]');
          if(!img) img = tdCmd.querySelector('img[src*="/graphic/command/"]');

          let axe = {icon_key:'', icon_src:'', icon_alt:'', axe_size:'unknown', watchtower:!!watchtower};
          if(img){
            const icon_src = img.src;
            const icon_key = normalizeIconKeyFromURL(icon_src);
            const icon_alt = (img.getAttribute('alt') || '').trim();
            const axe_size = detectAxeSizeFromKey(icon_key);
            axe = {icon_key, icon_src, icon_alt, axe_size, watchtower:!!watchtower};
          }

          const attackObj = {
            world: cfg.world,
            command_id: String(command_id),
            type, target, defender, origin, attacker, distance,
            arrival_text: arrivalText,
            arrival_at: Number(arrival_at), // Mantém precisão
            captured_at: now,
            source: 'local',
            lastSeen: now,
            icon_key: String(axe.icon_key || ''),
            icon_src: String(axe.icon_src || ''),
            icon_alt: String(axe.icon_alt || ''),
            axe_size: String(axe.axe_size || 'unknown'),
            watchtower: Boolean(axe.watchtower)
          };

          // --- FORÇAR ATUALIZAÇÃO (NUCLEAR) ---
          // Se o ataque já existe no cache, nós FORÇAMOS a atualização do horário
          // Isso corrige dados antigos (final 000) vindos do servidor
          if (typeof cache !== 'undefined' && cache instanceof Map && cache.has(String(command_id))) {
              const cached = cache.get(String(command_id));
              // Só atualiza se o novo tiver milissegundos e for diferente
              if (cached.arrival_at !== attackObj.arrival_at) {
                  cached.arrival_at = attackObj.arrival_at;
                  cached.arrival_text = attackObj.arrival_text; // Atualiza texto também
                  cached.lastSeen = now; // Marca como atualizado agora
                  // console.log('🔨 Force Update no Cache:', command_id, cached.arrival_at);
              }
          }
          // -------------------------------------

          list.push(attackObj);
        } catch(e){ dlog('Erro linha:', e); }
      });

      const onlyFuture = list.filter(a => (a.arrival_at || 0) > now);
      return cfg.provisionalEnabled ? applyProvisionalByOrigin(onlyFuture) : onlyFuture;
    } catch(e){ dlog('Erro collectAttacksFromDocument:', e); return []; }
  }

  // Cache do player logado (evita buscas repetidas)
  let __cachedPlayerName = null;
  let __cachedPlayerId = null;
  let __cachedPlayerTribeId = null;

  // Função para normalizar nomes (decodificar HTML entities, URL encoding, normalizar espaços)
  function normalizeName(name) {
    if (!name) return name;
    let normalized = String(name);

    // Decodificar HTML entities
    if (normalized.includes('&')) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = normalized;
      normalized = tempDiv.textContent || tempDiv.innerText || normalized;
    }

    // Decodificar URL encoding (pode ter múltiplas camadas)
    try {
      let decoded = decodeURIComponent(normalized);
      let lastDecoded = '';
      let attempts = 0;
      while (decoded !== lastDecoded && decoded.includes('%') && attempts < 3) {
        lastDecoded = decoded;
        decoded = decodeURIComponent(decoded);
        attempts++;
      }
      if (decoded !== normalized) {
        normalized = decoded;
      }
    } catch (e) {
      // Se falhar, usar como está
    }

    // Normalizar espaços e remover "+"
    normalized = normalized.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();

    return normalized;
  }

  // Função melhorada para obter player_id de scripts JavaScript (método mais seguro)
  function getPlayerIdFromScripts() {
    try {
      // Buscar em todos os scripts da página
      const scripts = document.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const content = script.textContent || script.innerHTML || '';

        // Padrões comuns: player_id, playerId, player.id, etc.
        const patterns = [
          /player_id["\s:=]+(\d+)/i,
          /playerId["\s:=]+(\d+)/i,
          /player\.id["\s:=]+(\d+)/i,
          /"player_id":\s*(\d+)/i,
          /'player_id':\s*(\d+)/i,
          /player_id\s*=\s*(\d+)/i,
          /user_id["\s:=]+(\d+)/i,
          /userId["\s:=]+(\d+)/i
        ];

        for (const pattern of patterns) {
          const match = content.match(pattern);
          if (match && match[1]) {
            const playerId = match[1].trim();
            if (/^\d+$/.test(playerId) && parseInt(playerId) > 0) {
              if (cfg.debug) dlog(`[getPlayerIdFromScripts] Player ID encontrado: ${playerId}`);
              return playerId;
            }
          }
        }
      }
    } catch (e) {
      if (cfg.debug) dlog('Erro ao buscar player_id em scripts:', e);
    }
    return null;
  }

  // Função melhorada para obter nome do player usando player_id + dados do mundo (método mais seguro)
  function getPlayerNameFromWorldData(playerId) {
    if (!playerId || !MUNDO_DADOS || !MUNDO_DADOS.loaded || !MUNDO_DADOS.jogadoresMap) {
      return null;
    }

    try {
      const player = MUNDO_DADOS.jogadoresMap.get(String(playerId));
      if (player && player.nome) {
        // Normalizar nome (remover "+" e normalizar espaços)
        const nomeNormalizado = player.nome.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
        if (cfg.debug) dlog(`[getPlayerNameFromWorldData] Nome encontrado via player_id ${playerId}: ${nomeNormalizado}`);
        return nomeNormalizado;
      }
    } catch (e) {
      if (cfg.debug) dlog('Erro ao buscar nome no mundo:', e);
    }
    return null;
  }

  function getLoggedPlayerNameFromDOM() {
    try {
      // MÉTODO 1: Procurar no menu lateral (mais confiável do DOM)
      const a = [...document.querySelectorAll('.menu-column-item a[href*="screen=info_player"]:not([href*="mode="])')]
        .map(x => (x.textContent || '').replace(/\s+/g, ' ').trim())
        .find(t => t && !/perfil|profile|estatística|realizaç/i.test(t) && t.length > 2);
      if (a) {
        return a.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
      }

      // MÉTODO 2: Procurar em outros links do menu
      const menuLinks = [...document.querySelectorAll('.menu-column-item a[href*="info_player"]')]
        .map(x => (x.textContent || '').replace(/\s+/g, ' ').trim())
        .find(t => t && !/perfil|profile|estatística|realizaç|estat/i.test(t) && t.length > 2 && !/^\d+$/.test(t));
      if (menuLinks) {
        return menuLinks.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
      }

      // MÉTODO 3: Título da página
      const titleMatch = document.title.match(/^(.+?)\s*-\s*(Guerras Tribais|Tribal Wars)/);
      if (titleMatch) {
        const name = titleMatch[1].trim();
        if (name && !/mundo|world/i.test(name) && name.length > 2) {
          return name.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    } catch (e) {
      // Silencioso
    }
    return null;
  }

  function getLoggedPlayerName(){
    try{
      // 1) Usar cache em memória se disponível
      if (__cachedPlayerName && __cachedPlayerName !== 'Jogador Desconhecido') {
        return __cachedPlayerName;
      }

      // 2) Usar cache persistente se disponível
      const cachedPlayer = GM_getValue('tw_cached_identity_player');
      if (cachedPlayer && cachedPlayer !== 'Jogador Desconhecido') {
        __cachedPlayerName = cachedPlayer;
        return cachedPlayer;
      }

      // 3) Obter do DOM
      const domName = getLoggedPlayerNameFromDOM();
      if (domName) {
        __cachedPlayerName = domName;
        GM_setValue('tw_cached_identity_player', domName);
        return domName;
      }

      // 4) Método seguro usando player_id e dados do mundo (se já carregados)
      if (!__cachedPlayerId) {
        __cachedPlayerId = getPlayerIdFromScripts();
      }

      if (__cachedPlayerId && MUNDO_DADOS && MUNDO_DADOS.loaded) {
        const nameFromWorld = getPlayerNameFromWorldData(__cachedPlayerId);
        if (nameFromWorld) {
          __cachedPlayerName = nameFromWorld;
          GM_setValue('tw_cached_identity_player', nameFromWorld);
          return nameFromWorld;
        }
      }

      return 'Jogador Desconhecido';
    }catch(e){
      dlog('Erro getLoggedPlayerName:', e);
      return 'Jogador Desconhecido';
    }
  }

  // Função melhorada para obter a tag da tribo do player logado (método mais seguro)
  function getLoggedPlayerTribeTag() {
    try {
      // 1) Usar cache persistente se disponível
      const cachedTribe = GM_getValue('tw_cached_identity_tribe');
      if (cachedTribe && cachedTribe !== 'NULL') {
        return cachedTribe;
      }

      // 2) Usar player_id em cache + dados do mundo (se já carregados)
      if (__cachedPlayerTribeId && MUNDO_DADOS && MUNDO_DADOS.loaded && MUNDO_DADOS.tribosMap) {
        const tribo = MUNDO_DADOS.tribosMap.get(String(__cachedPlayerTribeId));
        if (tribo && tribo.tag) {
          const tagNormalizada = normalizeName(tribo.tag);
          GM_setValue('tw_cached_identity_tribe', tagNormalizada);
          return tagNormalizada;
        }
      }

      // Tentar obter player_id se não temos em cache
      if (!__cachedPlayerId) {
        __cachedPlayerId = getPlayerIdFromScripts();
        if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] Player ID obtido: ${__cachedPlayerId || 'NÃO ENCONTRADO'}`);
      }

      // Se temos player_id, buscar direto nos dados do mundo (método mais seguro)
      if (__cachedPlayerId && MUNDO_DADOS && MUNDO_DADOS.loaded && MUNDO_DADOS.jogadoresMap) {
        const player = MUNDO_DADOS.jogadoresMap.get(String(__cachedPlayerId));
        if (cfg.debug) {
          dlog(`[getLoggedPlayerTribeTag] Buscando player_id ${__cachedPlayerId} no jogadoresMap (tamanho: ${MUNDO_DADOS.jogadoresMap.size})`);
          dlog(`[getLoggedPlayerTribeTag] Player encontrado: ${player ? 'SIM' : 'NÃO'}, idTribo: ${player?.idTribo || 'N/A'}`);
        }
        if (player && player.idTribo && player.idTribo !== '0') {
          __cachedPlayerTribeId = player.idTribo;
          const tribo = MUNDO_DADOS.tribosMap.get(String(player.idTribo));
          if (cfg.debug) {
            dlog(`[getLoggedPlayerTribeTag] Buscando tribo_id ${player.idTribo} no tribosMap (tamanho: ${MUNDO_DADOS.tribosMap.size})`);
            dlog(`[getLoggedPlayerTribeTag] Tribo encontrada: ${tribo ? 'SIM' : 'NÃO'}, tag: ${tribo?.tag || 'N/A'}`);
          }
          if (tribo && tribo.tag) {
            const tagNormalizada = normalizeName(tribo.tag);
            if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] ✅ Tag encontrada via player_id ${__cachedPlayerId}: [${tagNormalizada}] (tribo_id: ${player.idTribo})`);
            return tagNormalizada;
          } else {
            if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] ❌ Tribo ${player.idTribo} não encontrada ou sem tag`);
          }
        } else {
          if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] ❌ Player ${__cachedPlayerId} não encontrado ou sem idTribo (idTribo: ${player?.idTribo || 'N/A'})`);
        }
      } else {
        if (cfg.debug) {
          dlog(`[getLoggedPlayerTribeTag] ❌ Dados não disponíveis: player_id=${__cachedPlayerId || 'N/A'}, loaded=${MUNDO_DADOS?.loaded || false}, jogadoresMap=${MUNDO_DADOS?.jogadoresMap ? 'SIM' : 'NÃO'}`);
        }
      }

      // Fallback: Buscar pelo nome (menos confiável, mas funciona se player_id não estiver disponível)
      const playerName = getLoggedPlayerName();
      if (!playerName || playerName === 'Jogador Desconhecido') return null;

      if (!MUNDO_DADOS || !MUNDO_DADOS.loaded || !MUNDO_DADOS.jogadoresMap || MUNDO_DADOS.jogadoresMap.size === 0) {
        if (cfg.debug) dlog('[getLoggedPlayerTribeTag] Dados do mundo não carregados ainda');
        return null;
      }

      // Buscar o player pelo nome no jogadoresMap
      let playerFound = null;
      const playerNameNormalized = normalizeName(playerName); // Normalizar o nome do player logado também
      for (const [id, player] of MUNDO_DADOS.jogadoresMap.entries()) {
        if (player.nome) {
          // Normalizar ambos os nomes para comparação (remover "+" e normalizar espaços)
          const nomeNormalizado = normalizeName(player.nome);
          if (nomeNormalizado.toLowerCase() === playerNameNormalized.toLowerCase()) {
            playerFound = player;
            __cachedPlayerId = id; // Cachear o ID encontrado
            if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] Player encontrado via nome: ${playerNameNormalized} (ID: ${id})`);
            break;
          }
        }
      }

      if (!playerFound || !playerFound.idTribo) {
        if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] Player ${playerName} não encontrado ou sem tribo`);
        return null;
      }

      __cachedPlayerTribeId = playerFound.idTribo;
      const tribo = MUNDO_DADOS.tribosMap.get(playerFound.idTribo);
      if (!tribo || !tribo.tag) {
        if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] Tribo ${playerFound.idTribo} não encontrada ou sem tag`);
        return null;
      }

      const tagNormalizada = normalizeName(tribo.tag);
      if (cfg.debug) dlog(`[getLoggedPlayerTribeTag] Tag encontrada: [${tagNormalizada}] para player ${playerName}`);
      return tagNormalizada;
    } catch (e) {
      if (cfg.debug) dlog('Erro getLoggedPlayerTribeTag:', e);
      return null;
    }
  }

  // Função para obter o ID da tribo do jogador logado (mais seguro que tag)
  function getLoggedPlayerTribeId() {
    try {
      // Se já temos em cache, retornar
      if (__cachedPlayerTribeId && __cachedPlayerTribeId !== '0') {
        return String(__cachedPlayerTribeId);
      }

      // Tentar obter player_id se não temos em cache
      if (!__cachedPlayerId) {
        __cachedPlayerId = getPlayerIdFromScripts();
      }

      // Se temos player_id, buscar direto nos dados do mundo
      if (__cachedPlayerId && MUNDO_DADOS && MUNDO_DADOS.loaded && MUNDO_DADOS.jogadoresMap) {
        const player = MUNDO_DADOS.jogadoresMap.get(String(__cachedPlayerId));
        if (player && player.idTribo && player.idTribo !== '0') {
          __cachedPlayerTribeId = player.idTribo;
          return String(player.idTribo);
        }
      }

      // Fallback: Buscar pelo nome
      const playerName = getLoggedPlayerName();
      if (!playerName || playerName === 'Jogador Desconhecido') return null;

      if (!MUNDO_DADOS || !MUNDO_DADOS.loaded || !MUNDO_DADOS.jogadoresMap || MUNDO_DADOS.jogadoresMap.size === 0) {
        return null;
      }

      const playerNameNormalized = normalizeName(playerName);
      for (const [id, player] of MUNDO_DADOS.jogadoresMap.entries()) {
        if (player.nome) {
          const nomeNormalizado = normalizeName(player.nome);
          if (nomeNormalizado.toLowerCase() === playerNameNormalized.toLowerCase()) {
            __cachedPlayerId = id;
            if (player.idTribo && player.idTribo !== '0') {
              __cachedPlayerTribeId = player.idTribo;
              return String(player.idTribo);
            }
            break;
          }
        }
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  function collectAttacksFromDOM(){
    try{
      const table=document.querySelector(cfg.selectors.incomingTable);
      if(!table){ return []; }
      const rows=table.querySelectorAll(cfg.selectors.rows);
      const list=[]; const now=Date.now();
      rows.forEach((tr)=>{
        try{
          const tds=tr.querySelectorAll('td'); if(tds.length<7) return;
          const tdCmd=tds[0], tdTgt=tds[1], tdOrg=tds[2], tdPly=tds[3], tdDist=tds[4], tdArriv=tds[5], tdETA=tds[6];
          const type=(function(td){
            const sels=['.quickedit-label','.quickedit span','td:first-child span','span[class*="icon"]','img[src*="command"]'];
            for(const sel of sels){const el=td.querySelector(sel); if(el){const text=el.textContent?.trim(); if(text && text!=='&nbsp;') return text; if(el.tagName==='IMG'){const src=el.src||''; if(src.includes('attack')) return 'Ataque'; if(src.includes('support')) return 'Apoio'; if(src.includes('other')) return 'Outro';}}}
            const cellText=txt(td); if(cellText) return cellText.split(' ')[0]||'Comando'; return 'Comando';
          })(tdCmd);
          const target=txt(tdTgt);
          const origin=txt(tdOrg);
          const attacker=txt(tdPly);
          const distance=txt(tdDist);
          const defender=getLoggedPlayerName()||'';
          const arrivalText=txt(tdArriv);
          // --- CORREÇÃO PRINCIPAL AQUI ---
          // 1. Tenta ler a data absoluta COM milissegundos
          let arrival_at = parseArrivalAbsolute(tdArriv);

          // 2. Se falhar (retornar 0 ou null), usa o ETA como fallback
          if (!arrival_at) {
             const etaText = txt(tdETA);
             const etaMs = parseEtaToMs(etaText);
             if (etaMs != null) {
                 arrival_at = now + etaMs;
             }
          }
          // REMOVIDO: O bloco "else if" que sobrescrevia arrival_at se a diferença fosse > 30s.
          // Confiamos mais na leitura direta da tabela (que agora suporta milissegundos)
          // do que no cálculo ETA + Relógio do Cliente (que é impreciso).
          if ((arrival_at||0) <= now) return;
          let command_id=extractCommandId(tdCmd);
          if (!/^\d+$/.test(String(command_id||''))) {
            const hashInput=origin.toLowerCase()+'|'+target.toLowerCase()+'|'+Math.floor(arrival_at/1000);
            command_id=hashNumericId(hashInput);
          }
          const span=tdCmd.querySelector('span[data-command-id], span[class*="commandicon"]');
          const spanTitle=(span?.getAttribute('data-title')||span?.getAttribute('title')||'').trim();
          const watchtower=(span && span.classList.contains('commandicon-wt'))||/torre\s*de\s*vigia|watchtower|será\s*detectado\s*por\s*uma\s*torre/i.test(spanTitle);
          let img=tdCmd.querySelector('img[src*="/graphic/command/attack"]'); if(!img) img=tdCmd.querySelector('img[src*="/graphic/command/"]');
          let axe = {icon_key:'',icon_src:'',icon_alt:'',axe_size:'unknown',watchtower:!!watchtower};
          if(img){const icon_src=img.src;const icon_key=normalizeIconKeyFromURL(icon_src);const icon_alt=(img.getAttribute('alt')||'').trim();const axe_size=detectAxeSizeFromKey(icon_key);axe={icon_key,icon_src,icon_alt,axe_size,watchtower:!!watchtower};}
          list.push({
            world:cfg.world,
            command_id:String(command_id),
            type, target, defender, origin, attacker, distance,
            arrival_text:arrivalText,
            arrival_at:Number(arrival_at),
            captured_at:now,
            source:'local',
            lastSeen: now,
            icon_key:String(axe.icon_key||''),
            icon_src:String(axe.icon_src||''),
            icon_alt:String(axe.icon_alt||''),
            axe_size:String(axe.axe_size||'unknown'),
            watchtower:Boolean(axe.watchtower)
          });
        }catch(e){ dlog('Erro linha:', e); }
      });
      const onlyFuture = list.filter(a => (a.arrival_at||0) > now);
      return cfg.provisionalEnabled ? applyProvisionalByOrigin(onlyFuture) : onlyFuture;
    }catch(e){ dlog('Erro collectAttacksFromDOM:', e); return []; }
  }

  GM_addStyle(`
    /* Botão lateral - posição relativa para badge absoluto */
    #twInlineBtn{position:relative}
    #twInlineBtn.quest{width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;letter-spacing:.3px;background:#000000 !important;color:#ffffff !important;border:1.5px solid #5a3d0f;border-radius:3px;cursor:pointer;margin-top:4px;user-select:none}
    #twInlineBtn.quest:hover{filter:brightness(1.15)}
    #be-commands-send-btn.quest{width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;background:#333;color:#fff;border-radius:3px;cursor:pointer;margin-top:4px;user-select:none}
    #be-commands-send-btn.quest:hover{filter:brightness(1.15)}

    /* Badge de nobres estilo WhatsApp - pequeno e redondo no canto superior direito */
    #twInlineBtn .noble-badge {
      position: absolute;
      top: -8px;
      right: -8px;
      background: #dc3545; /* Vermelho vibrante como WhatsApp */
      color: #fff;
      border-radius: 50%;
      width: 18px !important;
      height: 18px !important;
      min-width: 18px !important;
      max-width: 18px !important;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: bold;
      border: 2px solid #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,0.4);
      padding: 0 !important;
      margin: 0 !important;
      line-height: 18px;
      z-index: 1000;
      overflow: hidden;
      box-sizing: border-box;
    }
    /* Badge para 99+ - levemente maior mas ainda circular */
    #twInlineBtn .noble-badge[data-count="99+"] {
      width: 20px !important;
      height: 20px !important;
      min-width: 20px !important;
      max-width: 20px !important;
      font-size: 8px;
      line-height: 20px;
    }
    #twInlineBtn .noble-badge:empty {
      display: none;
    }
    #tw-inline-wrap{margin-bottom:12px;border:1px solid #a8a39d;background:#e8e6e4;padding:6px;border-radius:4px}
    #tw-inline-header{display:flex;flex-direction:column;gap:6px;margin:8px 0}
    #tw-inline-header .rowA{display:flex;align-items:center;gap:8px;background:#e8e6e4;border:1px solid #d5d2ce;padding:6px;border-radius:4px}
    #tw-inline-header .rowA .spacer{flex:1}
    #tw-inline-header .rowB{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:8px;background:#e8e6e4;border:1px solid #d5d2ce;padding:6px;border-radius:4px}
    #tw-inline-header h3{margin:0;font-size:14px;color:#2b1a0f}
    #tw-version-badge{background:#a8a39d;color:#fff;border-radius:6px;padding:2px 6px;font-size:11px;margin-left:6px}
    #tw-inline-header .rowB label,
    #tw-inline-header .rowB button{padding:4px 8px;border-radius:6px;border:1px solid #888;background:#eee;color:#111;font-size:12px}
    #tw-inline-header .rowB label{display:flex;align-items:center;gap:6px;background:transparent;border:none;padding:0}
    #tw-inline-header input[type="checkbox"]{transform:scale(1.1)}
    #tw-inline-status{color:#4a3a22;font-size:12px}
    .tw-axe-multi{position:relative}
    #tw-axe-btn{cursor:pointer}
    #tw-axe-panel{position:absolute;top:110%;left:0;background:#fbf3da;border:1px solid #c9b27f;border-radius:6px;padding:8px 10px;z-index:9999;min-width:260px;box-shadow:0 4px 10px rgba(0,0,0,.15)}
    #tw-axe-panel label{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px}
    #tw-axe-panel hr{border:none;border-top:1px solid #d5d2ce;margin:6px 0}
    #tw-inline-stats{display:flex;gap:10px;align-items:center;margin:6px 0 4px 0;flex-wrap:wrap}
    .tw-badge{display:flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid #bbb;border-radius:999px;background:#f8f8f8;font-size:12px}
    .tw-badge img{height:16px;width:16px;image-rendering:pixelated}
    #tw-inline-body.hidden{display:none}
    .tw-blue-elves-table{width:100%;border-collapse:collapse;background:#e8e6e4 !important;border:1px solid #a8a39d}
    .tw-blue-elves-table th{background:#c4c0bb;color:#2b1a0f;border-bottom:1px solid #a8a39d}
    .tw-blue-elves-table th,.tw-blue-elves-table td{padding:6px 8px;border-bottom:1px solid #d5d2ce;white-space:nowrap;font-size:12px}
    .tw-blue-elves-table tr:nth-child(even) td{background:#f9f1d7}
    .tw-subtable{width:100%;border-collapse:collapse;margin-top:6px;border:1px solid #c8b589;background:#f8efd5}
    .tw-subtable th{background:#ddc79b;color:#2b1a0f;border-bottom:1px solid #b79b69}
    .tw-subtable th,.tw-subtable td{padding:4px 6px;border-bottom:1px solid #d5d2ce;white-space:nowrap;font-size:12px}
    .tw-subtable tr:nth-child(even) td{background:#fbf5e3}
    .tw-blue-elves-pill{display:inline-block;padding:2px 6px;border-radius:6px;background:#333;color:#fff;font-size:11px;border:1px solid rgba(0,0,0,.1)}
    .command-colored{font-weight:700;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000}
    .tw-axe-ctr{display:inline-flex;align-items:center;gap:4px;margin-right:8px}
    .tw-axe-ctr img{height:16px;width:16px;image-rendering:pixelated}
    .tw-axe-ctr .stack img{height:14px;width:14px}
    .tw-axe-ctr .num{font-weight:700;font-size:12px}
    .tw-row-player td{ background:#edd9a8 !important; }
    .tw-row-village td{ background:#e8e6e4 !important; }
    .tw-toggle{cursor:pointer;user-select:none;padding:0 6px;font-weight:700}
    .tw-label{font-weight:700}
    .tw-row-ignored { opacity: .55; }
    html:not(.tw-show-ignored) .tw-row-ignored { display: none !important; }

    /* Minimapa styles */
    #tw-minimap {
      max-width: 100%;
      min-height: 400px;
    }
    #tw-map-container {
      margin-top: 10px;
    }
    #tw-map-filters label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      cursor: pointer;
    }
    #tw-map-filters input[type="checkbox"] {
      transform: scale(1.1);
      cursor: pointer;
    }
    #tw-minimap:active {
      cursor: grabbing !important;
    }
    #tw-view-toggle.active {
      background: #27ae60 !important;
    }
  `);

  let uiWrap=null, uiBody=null, uiTbody=null, uiStatus=null, uiCollapseBtn=null, uiColorToggle=null, uiShowIgnored=null;
  let uiSupportsToggle=null, uiStats=null;
  let uiAxeBtn=null, uiAxePanel=null;
  const filters = { type:null, target:null, defender:null, origin:null, attacker:null, time:null };
  let uiInitialized=false;
  let cache=[];
  let __syncTimer = null;
  let __incomingsPageTimer = null;  // Timer para coleta rápida quando página incomings está aberta
  let __commandsPageTimer = null;   // Timer para coleta rápida quando página commands está aberta
  let __incomingsPagesTimer = null;  // Timer para busca de páginas adicionais (background sync interval)
  let __commandsPagesTimer = null;   // Timer para busca de páginas adicionais (background sync interval)
  let __tickTimer = null;
  let __nobleCountUpdateTimer = null;

  function colgroupHTML(){
    return `<colgroup><col style="width:40px"><col style="width:140px"><col style="width:220px"><col style="width:180px"><col style="width:220px"><col style="width:180px"><col style="width:140px"><col style="width:120px"></colgroup>`;
  }

  function buildStatusPrefix(){ return isIncomingsPage() ? '' : '🌐 Modo remoto — '; }
  function setStatus(msg, isError=false){
    if (!uiStatus) return;
    uiStatus.textContent='status: '+buildStatusPrefix()+msg;
    uiStatus.style.color=isError?'#b00020':'#4a3a22';
  }

  function startTick() {
    stopTick();
    __tickTimer = setInterval(tickCountdowns, 1000);
  }
  function stopTick() {
    if (__tickTimer) { clearInterval(__tickTimer); __tickTimer = null; }
  }



  function startSyncAndFetch() {
      // VERSÃO MINIMAL: Não busca dados do servidor, apenas envia
      // stopSync();
      // dlog("Painel visível. Buscando dados e iniciando sincronia periódica...");
      // fetchAndRender();
      // __syncTimer = setInterval(fetchAndRender, 30000);
      // startTick();
      return; // Desabilitado na versão minimal
  }

  function stopSync() {
      if (__syncTimer) {
          clearInterval(__syncTimer);
          __syncTimer = null;
          dlog("Sincronia periódica pausada.");
      }
      stopTick();
  }

  function setCollapsed(collapsed, persist = true) {
      if (!uiBody || !uiCollapseBtn) return;

      const isHidden = collapsed;
      uiBody.classList.toggle('hidden', isHidden);
      uiCollapseBtn.textContent = isHidden ? '▸' : '▾';
      __uiCollapsed = !!collapsed; // Sincronizar estado

      if (persist) {
          GM_setValue('tw_inline_collapsed', isHidden);
      }

      if (isHidden) {
          stopSync();
          stopServerDataFetch(); // Não buscar dados quando painel fechado
      } else {
          stopServerDataFetch(); // Painel aberto: usar fetchAndRender() em vez disso
          startSyncAndFetch();
      }

      updateEngines(); // Atualizar engines quando colapsar/expandir
  }

  function axePanelHTML(){
    return `<div id="tw-axe-multi" class="tw-axe-multi"><button id="tw-axe-btn" type="button" title="Filtrar por tipo de machado">Tipos de ataque ▾</button><div id="tw-axe-panel" class="tw-axe-panel" hidden><label><input type="checkbox" data-type="all"> Todos</label><hr><label><input type="checkbox" data-type="normal"> Normal (sem cor)</label><label><input type="checkbox" data-type="small"> Machado verde (small)</label><label><input type="checkbox" data-type="medium"> Machado marrom (medium)</label><label><input type="checkbox" data-type="large"> Machado vermelho (large)</label><label><input type="checkbox" data-type="small_medium"> Machado verde e marrom (provisório)</label><label><input type="checkbox" data-type="noble"> Nobre</label></div></div>`;
  }


  function createInlineUI(){
    if (uiInitialized) return;
    const incomings=document.querySelector(cfg.selectors.incomingTable);
    const mountPoint=incomings || document.querySelector('#content_value') || document.body;

    uiWrap=document.createElement('div');
    uiWrap.id='tw-inline-wrap';
    uiWrap.innerHTML=`<div id="tw-inline-header"><div class="rowA"><button id="tw-inline-collapse" type="button" title="Colapsar/Expandir">▾</button><h3>Central Fellas <span id="tw-version-badge">${esc(VERSION_TEXT)}</span></h3><span class="spacer"></span><span id="tw-inline-status">status: ${esc(buildStatusPrefix())}pronto</span></div><div class="rowB">${axePanelHTML()}<button id="tw-view-toggle" type="button" title="Alternar entre tabela e minimapa" style="background:#3498db;color:white;border:none;padding:4px 8px;border-radius:6px;font-size:12px;cursor:pointer">🗺️ Mapa</button><label title="Ativa/Desativa as cores por etiqueta"><input type="checkbox" id="tw-colorize-toggle"> Cores</label><label title="Mostrar/ocultar Apoios"><input type="checkbox" id="tw-supports-toggle"> Apoios</label><label title="Exibir linhas ignoradas (jogo/servidor)"><input type="checkbox" id="tw-show-ignored"> Mostrar ataques ocultos</label></div></div><div id="tw-inline-stats"></div><div id="tw-inline-body" class="tw-inline-body"><div id="tw-inline-filters"><input id="tw-f-type" placeholder="Comando (Explorador, Nobre...)"><input id="tw-f-target" placeholder="Destino"><input id="tw-f-defender" placeholder="Defensor (jogador)"><input id="tw-f-origin" placeholder="Origem"><input id="tw-f-attacker" placeholder="Atacante"><select id="tw-f-time"><option value="">Chegada: qualquer</option><option value="15">≤ 15 min</option><option value="30">≤ 30 min</option><option value="60">≤ 60 min</option><option value="180">≤ 3 h</option><option value="1440">≤ 24 h</option></select></div><div id="tw-map-container" style="display:none"><div id="tw-map-filters" style="margin-bottom:10px;padding:8px;background:#e8e6e4;border:1px solid #d5d2ce;border-radius:4px"><label style="margin-right:15px"><input type="checkbox" id="map-filter-noble" checked> 👑 Nobres</label><label style="margin-right:15px"><input type="checkbox" id="map-filter-small" checked> 🟢 Small</label><label style="margin-right:15px"><input type="checkbox" id="map-filter-medium" checked> 🟤 Medium</label><label style="margin-right:15px"><input type="checkbox" id="map-filter-large" checked> 🔴 Large</label><label style="margin-right:15px"><input type="checkbox" id="map-filter-normal" checked> ⚪ Normal</label><label style="margin-right:15px"><input type="checkbox" id="map-filter-support" checked> 🛡️ Apoio</label></div><div id="tw-map-noble-radius-players" style="margin-bottom:10px;padding:8px;background:#e8f5e9;border:1px solid #4caf50;border-radius:4px"><div style="margin-bottom:6px;font-weight:bold;font-size:12px;color:#2e7d32">⚔️ Raio de Nobres</div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:4px;font-size:11px"><span>Base:</span><input type="text" id="map-noble-base-players" placeholder="X|Y" style="width:70px;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:11px"></label><label style="display:flex;align-items:center;gap:4px;font-size:11px"><span>Raio:</span><input type="number" id="map-noble-radius-input-players" placeholder="Campos" min="1" max="100" value="20" style="width:70px;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:11px"></label><label style="display:flex;align-items:center;gap:4px;font-size:11px"><span>Velocidade:</span><input type="number" id="map-noble-speed-players" placeholder="2.0" step="0.1" min="0.1" max="10" value="2.0" style="width:70px;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:11px"></label><button id="map-noble-calculate-players" type="button" style="background:#4caf50;color:white;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold">Calcular</button><button id="map-noble-clear-players" type="button" style="background:#f44336;color:white;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px">Limpar</button></div><div id="map-noble-info-players" style="margin-top:6px;font-size:10px;color:#666;font-style:italic"></div></div><div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;padding:6px;background:#f0f0f0;border-radius:4px"><span style="font-size:12px;font-weight:bold">Tamanho do mapa:</span><button id="map-size-minus" type="button" title="Diminuir altura do mapa" style="background:#6c757d;color:white;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:14px">−</button><span id="map-size-display" style="min-width:80px;text-align:center;font-size:12px">800px</span><button id="map-size-plus" type="button" title="Aumentar altura do mapa" style="background:#6c757d;color:white;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:14px">+</button><button id="map-size-reset" type="button" title="Restaurar tamanho padrão" style="background:#28a745;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px">Resetar</button><button id="map-tribes-config" type="button" title="Configurar tribos de interesse" style="background:#007bff;color:white;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:auto">🎨 Tribos</button></div><div id="map-tribes-panel" style="display:none;margin-bottom:8px;padding:10px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px"><div style="margin-bottom:8px;font-weight:bold;font-size:12px">Tribos de Interesse:</div><div style="margin-bottom:10px;padding:8px;background:#fff;border:1px solid #ddd;border-radius:4px"><div style="margin-bottom:6px;font-size:11px;color:#666">Buscar tribo para adicionar:</div><input type="text" id="map-tribes-search" placeholder="Digite tag ou nome da tribo..." style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:12px;margin-bottom:6px"><div id="map-tribes-suggestions" style="max-height:200px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;background:#fff;display:none"></div></div><div id="map-tribes-list" style="margin-bottom:8px;max-height:150px;overflow-y:auto"></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="text" id="map-tribes-add-input" placeholder="ID ou Tag da tribo" style="flex:1;min-width:150px;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:12px;display:none"><input type="color" id="map-tribes-add-color" value="#ff0000" title="Cor da tribo" style="width:50px;height:30px;cursor:pointer;border:1px solid #ccc;border-radius:4px"><button id="map-tribes-add-btn" type="button" style="background:#28a745;color:white;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;display:none">Adicionar</button></div></div><canvas id="tw-minimap" width="800" height="800" style="border:1px solid #a8a39d;background:#e8e6e4;display:block;width:100%;cursor:grab;touch-action:none"></canvas><div style="margin-top:8px;font-size:11px;color:#666">🖱️ Arraste para mover | 🔍 Roda do mouse para zoom</div></div><table id="tw-table-container" class="tw-blue-elves-table">${colgroupHTML()}<thead><tr><th><img src="${DEFAULT_AXE_ICON}" style="height:16px;width:16px;image-rendering:pixelated" alt="Machado"></th><th>Comando</th><th>Destino</th><th>Defensor</th><th>Origem</th><th>Atacante</th><th>Chegada</th><th>Chega em</th></tr></thead><tbody id="tw-inline-tbody"></tbody></table></div>`;
    if (incomings && incomings.parentNode) incomings.parentNode.insertBefore(uiWrap, incomings);
    else mountPoint.prepend(uiWrap);

    uiBody=uiWrap.querySelector('#tw-inline-body');
    uiTbody=uiWrap.querySelector('#tw-inline-tbody');
    uiStatus=uiWrap.querySelector('#tw-inline-status');
    uiCollapseBtn=uiWrap.querySelector('#tw-inline-collapse');
    uiColorToggle=uiWrap.querySelector('#tw-colorize-toggle');
    uiSupportsToggle=uiWrap.querySelector('#tw-supports-toggle');
    uiStats=uiWrap.querySelector('#tw-inline-stats');
    uiShowIgnored=uiWrap.querySelector('#tw-show-ignored');
    uiAxeBtn = uiWrap.querySelector('#tw-axe-btn');
    uiAxePanel = uiWrap.querySelector('#tw-axe-panel');

    // Minimapa elements
    const viewToggle = uiWrap.querySelector('#tw-view-toggle');
    const mapContainer = uiWrap.querySelector('#tw-map-container');
    const tableContainer = uiWrap.querySelector('#tw-table-container');
    const mapFilterNoble = uiWrap.querySelector('#map-filter-noble');
    const mapFilterSmall = uiWrap.querySelector('#map-filter-small');
    const mapFilterMedium = uiWrap.querySelector('#map-filter-medium');
    const mapFilterLarge = uiWrap.querySelector('#map-filter-large');
    const mapFilterSupport = uiWrap.querySelector('#map-filter-support');

    // View toggle (Tabela/Mapa)
    let isMapView = GM_getValue('tw_map_view', false);
    function toggleView() {
      isMapView = !isMapView;
      GM_setValue('tw_map_view', isMapView);

      if (isMapView) {
        if (mapContainer) mapContainer.style.display = 'block';
        if (tableContainer) tableContainer.style.display = 'none';
        if (viewToggle) {
          viewToggle.textContent = '📊 Tabela';
          viewToggle.classList.add('active');
        }
        setupMapInteractions(); // Configurar zoom e pan
        // Aplicar tamanho salvo do mapa
        const savedHeight = GM_getValue('tw_map_height', 800);
        const canvas = document.getElementById('tw-minimap');
        if (canvas) {
          canvas.height = Math.max(200, Math.min(1000, savedHeight));
          canvas.style.height = canvas.height + 'px';
          const sizeDisplay = document.getElementById('map-size-display');
          if (sizeDisplay) sizeDisplay.textContent = canvas.height + 'px';
        }
        // Forçar recarregamento de dados do mundo ao abrir o mapa
        MUNDO_DADOS.loaded = false;
        renderMinimap().catch(e => dlog('Erro ao renderizar mapa:', e));
      } else {
        if (mapContainer) mapContainer.style.display = 'none';
        if (tableContainer) tableContainer.style.display = 'table';
        if (viewToggle) {
          viewToggle.textContent = '🗺️ Mapa';
          viewToggle.classList.remove('active');
        }
        renderTable().catch(e => dlog('Erro:', e));
      }
    }

    if (isMapView) {
      if (mapContainer) mapContainer.style.display = 'block';
      if (tableContainer) tableContainer.style.display = 'none';
      if (viewToggle) {
        viewToggle.textContent = '📊 Tabela';
        viewToggle.classList.add('active');
      }
      setupMapInteractions(); // Configurar zoom e pan quando mapa já está visível
      // Forçar recarregamento de dados do mundo ao abrir o mapa
      MUNDO_DADOS.loaded = false;
      renderMinimap().catch(e => dlog('Erro ao renderizar mapa:', e));
    }

    if (viewToggle) viewToggle.addEventListener('click', toggleView);

    // Map filter listeners
    const mapFilterNormal = uiWrap.querySelector('#map-filter-normal');
    if (mapFilterNoble) mapFilterNoble.addEventListener('change', () => { if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); });
    if (mapFilterSmall) mapFilterSmall.addEventListener('change', () => { if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); });
    if (mapFilterMedium) mapFilterMedium.addEventListener('change', () => { if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); });
    if (mapFilterLarge) mapFilterLarge.addEventListener('change', () => { if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); });
    if (mapFilterNormal) mapFilterNormal.addEventListener('change', () => { if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); });
    if (mapFilterSupport) mapFilterSupport.addEventListener('change', () => { if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); });

    // Configurar raio de nobres (variável global para acesso em renderMinimap)
    window.__nobleRadiusStatePlayers = window.__nobleRadiusStatePlayers || {
      baseX: null,
      baseY: null,
      radius: null,
      speed: 2.0,
      enabled: false
    };
    const nobleRadiusState = window.__nobleRadiusStatePlayers;

    const nobleBaseInput = uiWrap.querySelector('#map-noble-base-players');
    const nobleRadiusInput = uiWrap.querySelector('#map-noble-radius-input-players');
    const nobleSpeedInput = uiWrap.querySelector('#map-noble-speed-players');
    const nobleCalculateBtn = uiWrap.querySelector('#map-noble-calculate-players');
    const nobleClearBtn = uiWrap.querySelector('#map-noble-clear-players');
    const nobleInfoDiv = uiWrap.querySelector('#map-noble-info-players');

    // Função para desenhar raio e calcular tempos (global para acesso em renderMinimap)
    window.drawNobleRadiusPlayers = function(ctx, canvas, area, sxCanvas, syCanvas) {
      const state = window.__nobleRadiusStatePlayers;
      if (!state || !state.enabled || !state.baseX || !state.baseY || !state.radius) {
        return;
      }

      const baseX = state.baseX;
      const baseY = state.baseY;
      const radius = state.radius;
      const speed = state.speed || 2.0;

      // Função auxiliar para calcular distância
      function calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
      }

      // Função auxiliar para calcular tempo de nobre
      function calculateNobleTime(distance, speed) {
        const baseTimeMinutes = 35; // 35 minutos por campo
        const totalMinutes = (distance * baseTimeMinutes) / speed;
        return totalMinutes;
      }

      // Função auxiliar para formatar tempo (com segundos quando necessário)
      function formatTime(minutes) {
        const totalSeconds = Math.round(minutes * 60);
        const hours = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;

        if (hours > 0) {
          return hours + 'h' + (mins > 0 ? mins + 'min' : '') + (secs > 0 && mins === 0 ? secs + 's' : '');
        } else if (mins > 0) {
          return mins + 'min' + (secs > 0 ? secs + 's' : '');
        } else {
          return secs + 's';
        }
      }

      // Verificar se a base está na área visível
      if (baseX < area.x_min || baseX >= area.x_max || baseY < area.y_min || baseY >= area.y_max) {
        return;
      }

      // Calcular posição no canvas
      const canvasX = (baseX - area.x_min) * sxCanvas;
      const canvasY = (baseY - area.y_min) * syCanvas;

      // Desenhar círculo do raio
      ctx.save();
      ctx.strokeStyle = '#ffeb3b'; // Amarelo
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]); // Linha tracejada
      ctx.beginPath();
      const radiusPixels = radius * sxCanvas; // Converter campos para pixels
      ctx.arc(canvasX, canvasY, radiusPixels, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();

      // Desenhar ponto central
      ctx.save();
      ctx.fillStyle = '#ffeb3b';
      ctx.beginPath();
      ctx.arc(canvasX, canvasY, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      // Calcular e mostrar tempo no limite do raio (borda do círculo)
      const timeAtRadius = calculateNobleTime(radius, speed);
      const timeText = formatTime(timeAtRadius);

      // Desenhar texto no limite do raio (em 4 pontos cardeais para melhor visibilidade)
      const angles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]; // Norte, Leste, Sul, Oeste

      angles.forEach((angle, index) => {
        const textX = canvasX + Math.cos(angle) * radiusPixels;
        const textY = canvasY + Math.sin(angle) * radiusPixels;

        ctx.save();
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Desenhar fundo para legibilidade
        const textWidth = ctx.measureText(timeText).width;
        const padding = 4;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(textX - textWidth / 2 - padding, textY - 8, textWidth + padding * 2, 16);

        // Desenhar texto
        ctx.fillStyle = '#ffeb3b';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.strokeText(timeText, textX, textY);
        ctx.fillText(timeText, textX, textY);
        ctx.restore();
      });
    };

    if (nobleCalculateBtn) {
      nobleCalculateBtn.addEventListener('click', () => {
        const baseText = (nobleBaseInput?.value || '').trim();
        const radiusValue = parseInt(nobleRadiusInput?.value || '20');
        const speedValue = parseFloat(nobleSpeedInput?.value || '2.0');

        if (!baseText) {
          if (nobleInfoDiv) nobleInfoDiv.textContent = '⚠️ Digite as coordenadas base (X|Y)';
          return;
        }

        // Parse coordenadas (formato: X|Y ou X Y)
        const coords = baseText.split(/[|\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (coords.length !== 2) {
          if (nobleInfoDiv) nobleInfoDiv.textContent = '⚠️ Formato inválido. Use: X|Y (ex: 468|526)';
          return;
        }

        nobleRadiusState.baseX = coords[0];
        nobleRadiusState.baseY = coords[1];
        nobleRadiusState.radius = radiusValue;
        nobleRadiusState.speed = speedValue;
        nobleRadiusState.enabled = true;

        if (nobleInfoDiv) {
          nobleInfoDiv.textContent = `✅ Base: ${coords[0]}|${coords[1]} | Raio: ${radiusValue} campos | Velocidade: ${speedValue}x`;
        }

        // Redesenhar mapa
        if (isMapView) {
          renderMinimap().catch(e => dlog('Erro:', e));
        }
      });
    }

    if (nobleClearBtn) {
      nobleClearBtn.addEventListener('click', () => {
        nobleRadiusState.enabled = false;
        nobleRadiusState.baseX = null;
        nobleRadiusState.baseY = null;
        nobleRadiusState.radius = null;
        if (nobleBaseInput) nobleBaseInput.value = '';
        if (nobleInfoDiv) nobleInfoDiv.textContent = '';

        // Redesenhar mapa
        if (isMapView) {
          renderMinimap().catch(e => dlog('Erro:', e));
        }
      });
    }

    // Map size controls
    const mapSizeMinus = uiWrap.querySelector('#map-size-minus');
    const mapSizePlus = uiWrap.querySelector('#map-size-plus');
    const mapSizeReset = uiWrap.querySelector('#map-size-reset');
    const mapSizeDisplay = uiWrap.querySelector('#map-size-display');
    const mapCanvas = uiWrap.querySelector('#tw-minimap');

    const MAP_SIZE_KEY = 'tw_map_height';
    const MAP_SIZE_DEFAULT = 800;
    const MAP_SIZE_MIN = 200;
    const MAP_SIZE_MAX = 1000;
    const MAP_SIZE_STEP = 50;

    let currentMapHeight = GM_getValue(MAP_SIZE_KEY, MAP_SIZE_DEFAULT);
    currentMapHeight = Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, currentMapHeight));

    function updateMapSize() {
      if (mapCanvas) {
        mapCanvas.height = currentMapHeight;
        mapCanvas.style.height = currentMapHeight + 'px';
        if (mapSizeDisplay) mapSizeDisplay.textContent = currentMapHeight + 'px';
        GM_setValue(MAP_SIZE_KEY, currentMapHeight);
        if (isMapView) renderMinimap().catch(e => dlog('Erro:', e));
      }
    }

    if (mapSizeMinus) {
      mapSizeMinus.addEventListener('click', () => {
        currentMapHeight = Math.max(MAP_SIZE_MIN, currentMapHeight - MAP_SIZE_STEP);
        updateMapSize();
      });
    }

    if (mapSizePlus) {
      mapSizePlus.addEventListener('click', () => {
        currentMapHeight = Math.min(MAP_SIZE_MAX, currentMapHeight + MAP_SIZE_STEP);
        updateMapSize();
      });
    }

    if (mapSizeReset) {
      mapSizeReset.addEventListener('click', () => {
        currentMapHeight = MAP_SIZE_DEFAULT;
        updateMapSize();
      });
    }

    // Aplicar tamanho salvo ao carregar
    if (mapCanvas && isMapView) {
      updateMapSize();
    }

    // Carregar configuração de tribos
    loadTribesConfig();

    // Configurar painel de tribos
    const mapTribesConfigBtn = uiWrap.querySelector('#map-tribes-config');
    const mapTribesPanel = uiWrap.querySelector('#map-tribes-panel');
    const mapTribesList = uiWrap.querySelector('#map-tribes-list');
    const mapTribesSearch = uiWrap.querySelector('#map-tribes-search');
    const mapTribesSuggestions = uiWrap.querySelector('#map-tribes-suggestions');
    const mapTribesAddInput = uiWrap.querySelector('#map-tribes-add-input');
    const mapTribesAddColor = uiWrap.querySelector('#map-tribes-add-color');
    const mapTribesAddBtn = uiWrap.querySelector('#map-tribes-add-btn');

    function renderTribesList() {
      if (!mapTribesList) return;

      mapTribesList.innerHTML = '';

      if (tribesConfig.size === 0) {
        mapTribesList.innerHTML = '<div style="color:#666;font-size:11px;font-style:italic;padding:10px;text-align:center">Nenhuma tribo configurada.<br>Adicione IDs ou tags de tribos para destacá-las no mapa.</div>';
        return;
      }

      tribesConfig.forEach((config, triboId) => {
        const tribo = MUNDO_DADOS.tribosMap.get(triboId);
        const triboName = tribo ? `[${tribo.tag}] ${tribo.nome}` : `Tribo ${triboId}`;

        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px;background:#fff;border:1px solid #ddd;border-radius:4px;margin-bottom:4px';
        item.innerHTML = `
          <div style="width:30px;height:20px;background:${config.color};border:1px solid #333;border-radius:3px"></div>
          <span style="flex:1;font-size:12px">${esc(triboName)}</span>
          <span style="font-size:10px;color:#666">ID: ${triboId}</span>
          <button type="button" class="map-tribe-remove" data-tribe-id="${triboId}" style="background:#dc3545;color:white;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px">Remover</button>
        `;
        mapTribesList.appendChild(item);
      });

      // Adicionar listeners para remover
      mapTribesList.querySelectorAll('.map-tribe-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const tribeId = btn.getAttribute('data-tribe-id');
          if (tribeId && tribesConfig.has(tribeId)) {
            tribesConfig.delete(tribeId);
            saveTribesConfig();
            renderTribesList();
            if (isMapView) renderMinimap().catch(e => dlog('Erro:', e));
          }
        });
      });
    }

    // Função para renderizar sugestões de tribos
    function renderTribesSuggestions(searchTerm = '') {
      if (!mapTribesSuggestions) return;

      if (!MUNDO_DADOS.loaded || !MUNDO_DADOS.tribosMap.size) {
        mapTribesSuggestions.innerHTML = '<div style="padding:8px;text-align:center;color:#666;font-size:11px">Carregando tribos...</div>';
        mapTribesSuggestions.style.display = 'block';
        return;
      }

      const term = searchTerm.toLowerCase().trim();
      const suggestions = [];

      for (const [id, tribo] of MUNDO_DADOS.tribosMap.entries()) {
        // Pular tribo vazia/barbárica (id 0 ou sem tag)
        if (id === '0' || !tribo.tag) continue;

        // Verificar se já está configurada
        if (tribesConfig.has(id)) continue;

        const tag = (tribo.tag || '').toLowerCase();
        const nome = (tribo.nome || '').toLowerCase();
        const idStr = id.toLowerCase();

        // Filtrar por termo de busca
        if (!term || tag.includes(term) || nome.includes(term) || idStr.includes(term)) {
          suggestions.push({ id, tribo });
        }
      }

      // Ordenar por tag
      suggestions.sort((a, b) => {
        const tagA = (a.tribo.tag || '').toLowerCase();
        const tagB = (b.tribo.tag || '').toLowerCase();
        return tagA.localeCompare(tagB);
      });

      if (suggestions.length === 0) {
        mapTribesSuggestions.innerHTML = '<div style="padding:8px;text-align:center;color:#666;font-size:11px">Nenhuma tribo encontrada</div>';
        mapTribesSuggestions.style.display = 'block';
        return;
      }

      mapTribesSuggestions.innerHTML = '';

      // Limitar a 50 sugestões para performance
      suggestions.slice(0, 50).forEach(({ id, tribo }) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-bottom:1px solid #eee;transition:background 0.2s';
        item.onmouseenter = () => item.style.background = '#f0f0f0';
        item.onmouseleave = () => item.style.background = '';
        item.innerHTML = `
          <span style="flex:1;font-size:12px"><strong>[${esc(tribo.tag || 'N/A')}]</strong> ${esc(tribo.nome || 'Sem nome')}</span>
          <span style="font-size:10px;color:#666">ID: ${id}</span>
          <button type="button" class="map-tribe-add-suggestion" data-tribe-id="${id}" style="background:#007bff;color:white;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px">Adicionar</button>
        `;
        mapTribesSuggestions.appendChild(item);
      });

      // Adicionar listeners para adicionar tribo das sugestões
      mapTribesSuggestions.querySelectorAll('.map-tribe-add-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
          const tribeId = btn.getAttribute('data-tribe-id');
          if (tribeId) {
            const tribo = MUNDO_DADOS.tribosMap.get(tribeId);
            const color = mapTribesAddColor ? mapTribesAddColor.value : '#ff0000';
            const triboName = tribo ? tribo.nome : tribeId;
            tribesConfig.set(tribeId, { color, name: triboName });
            saveTribesConfig();
            renderTribesList();
            mapTribesSearch.value = '';
            mapTribesSuggestions.style.display = 'none';
            if (isMapView) renderMinimap().catch(e => dlog('Erro:', e));
          }
        });
      });

      mapTribesSuggestions.style.display = 'block';
    }

    // Busca de tribos
    if (mapTribesSearch && mapTribesSuggestions) {
      let searchTimeout = null;

      mapTribesSearch.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const term = mapTribesSearch.value;

        if (!term) {
          mapTribesSuggestions.style.display = 'none';
          return;
        }

        // Debounce para melhor performance
        searchTimeout = setTimeout(() => {
          renderTribesSuggestions(term);
        }, 300);
      });

      mapTribesSearch.addEventListener('focus', () => {
        if (mapTribesSearch.value) {
          renderTribesSuggestions(mapTribesSearch.value);
        } else {
          renderTribesSuggestions('');
        }
      });

      // Fechar sugestões ao clicar fora
      document.addEventListener('click', (e) => {
        if (mapTribesPanel && mapTribesSuggestions &&
            !mapTribesPanel.contains(e.target) &&
            e.target !== mapTribesConfigBtn) {
          mapTribesSuggestions.style.display = 'none';
        }
      });
    }

    // Toggle do painel de tribos
    if (mapTribesConfigBtn && mapTribesPanel) {
      mapTribesConfigBtn.addEventListener('click', () => {
        const isVisible = mapTribesPanel.style.display !== 'none';
        mapTribesPanel.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) {
          renderTribesList();
          // Se os dados do mundo não foram carregados, tentar carregar
          if (!MUNDO_DADOS.loaded) {
            loadWorldData().then(() => {
              if (mapTribesSearch && mapTribesSearch.value) {
                renderTribesSuggestions(mapTribesSearch.value);
              }
            }).catch(e => dlog('Erro ao carregar dados do mundo:', e));
          }
        }
      });
    }

    // Adicionar tribo
    if (mapTribesAddBtn && mapTribesAddInput && mapTribesAddColor) {
      function addTribe() {
        const input = mapTribesAddInput.value.trim();
        if (!input) {
          alert('Digite o ID ou tag da tribo');
          return;
        }

        // Tentar encontrar a tribo por ID ou tag
        let foundTribeId = null;

        // Buscar por ID
        if (MUNDO_DADOS.tribosMap.has(input)) {
          foundTribeId = input;
        } else {
          // Buscar por tag
          for (const [id, tribo] of MUNDO_DADOS.tribosMap.entries()) {
            if (tribo.tag && tribo.tag.toLowerCase() === input.toLowerCase()) {
              foundTribeId = id;
              break;
            }
          }
        }

        if (!foundTribeId) {
          // Se não encontrou, usar o input como ID mesmo (pode ser uma tribo que ainda não carregou)
          foundTribeId = input;
        }

        const color = mapTribesAddColor.value;
        const triboName = MUNDO_DADOS.tribosMap.get(foundTribeId)?.nome || foundTribeId;
        tribesConfig.set(foundTribeId, { color, name: triboName });
        saveTribesConfig();
        renderTribesList();
        mapTribesAddInput.value = '';

        if (isMapView) renderMinimap().catch(e => dlog('Erro:', e));
      }

      mapTribesAddBtn.addEventListener('click', addTribe);
      mapTribesAddInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          addTribe();
        }
      });
    }

    // Renderizar lista inicial
    renderTribesList();

    if (uiColorToggle)    uiColorToggle.checked = !!cfg.colorizeEnabled;
    if (uiSupportsToggle) uiSupportsToggle.checked = !!cfg.supportsVisible;
    if (uiShowIgnored) {
      uiShowIgnored.checked = !!cfg.showIgnored;
      document.documentElement.classList.toggle('tw-show-ignored', !!cfg.showIgnored);
    }

    setupInlineListeners();
    setupTogglesDelegation();
    setupAxePanel();
    attachViewportObserver(uiWrap); // Pausa por viewport
    uiInitialized=true;

    const startCollapsed = !!GM_getValue('tw_inline_collapsed', true);
    setCollapsed(startCollapsed, false);
  }

  function setupInlineListeners(){
    uiCollapseBtn.addEventListener('click', ()=>{
        const isCurrentlyCollapsed = uiBody.classList.contains('hidden');
        setCollapsed(!isCurrentlyCollapsed, true);
    });

    uiColorToggle.addEventListener('change', ()=>{
      cfg.colorizeEnabled = uiColorToggle.checked;
      GM_setValue('tw_colorize_enabled', cfg.colorizeEnabled);
      const isMapView = GM_getValue('tw_map_view', false);
      if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); else renderTable().catch(e => dlog('Erro:', e));
    });
    uiSupportsToggle.addEventListener('change', ()=>{
      cfg.supportsVisible = uiSupportsToggle.checked;
      GM_setValue('tw_supports_visible', cfg.supportsVisible);
      const isMapView = GM_getValue('tw_map_view', false);
      if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); else renderTable().catch(e => dlog('Erro:', e));
    });
    uiShowIgnored.addEventListener('change', ()=>{
      cfg.showIgnored = uiShowIgnored.checked;
      GM_setValue('tw_show_ignored', cfg.showIgnored);
      document.documentElement.classList.toggle('tw-show-ignored', !!cfg.showIgnored);
      const isMapView = GM_getValue('tw_map_view', false);
      if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); else renderTable().catch(e => dlog('Erro:', e));
    });

    let t;
    ['tw-f-type','tw-f-target','tw-f-defender','tw-f-origin','tw-f-attacker','tw-f-time']
      .forEach(id=>{
        const el = document.getElementById(id);
        if (!el) return;
        const key = id.replace('tw-f-','');
        filters[key]=el;

        if (id!=='tw-f-time') {
          el.addEventListener('input', ()=>{
            clearTimeout(t);
            t=setTimeout(()=>{
              const isMapView = GM_getValue('tw_map_view', false);
              if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); else renderTable().catch(e => dlog('Erro:', e));
            }, 150);
          });
        } else {
          el.addEventListener('change', ()=>{
            const isMapView = GM_getValue('tw_map_view', false);
            if (isMapView) renderMinimap().catch(e => dlog('Erro:', e)); else renderTable().catch(e => dlog('Erro:', e));
          });
        }
      });
  }

  function setAxePanelFromState(){
    if (!uiAxePanel) return;
    const chks = uiAxePanel.querySelectorAll('input[type="checkbox"][data-type]');
    const allSelected = axeSelected.has('all');
    const selectedTypes = new Set(axeSelected);
    const ALL_TYPES = ['normal','small','medium','large','small_medium','noble'];
    chks.forEach(chk=>{
      const t = chk.getAttribute('data-type');
      if (t==='all'){
        chk.checked = allSelected || ALL_TYPES.every(tp => selectedTypes.has(tp));
      } else {
        chk.checked = allSelected ? true : selectedTypes.has(t);
      }
    });
  }
  function updateStateFromAxePanel(e){
    if (!uiAxePanel) return;
    const target = e?.target;
    const ALL_TYPES = ['normal','small','medium','large','small_medium','noble'];
    if (target && target.matches('input[type="checkbox"][data-type]')){
      const t = target.getAttribute('data-type');
      if (t==='all'){
        if (target.checked){ axeSelected = new Set(['all']); }
        else { axeSelected = new Set(); }
      } else {
        const next = new Set(axeSelected);
        next.delete('all');
        if (target.checked) next.add(t); else next.delete(t);
        if (ALL_TYPES.every(tp => next.has(tp))) {
          axeSelected = new Set(['all']);
        } else {
          axeSelected = next;
        }
      }
      saveAxeSelected(axeSelected);
      setAxePanelFromState();
      renderTable().catch(e => dlog('Erro:', e));
    }
  }
  function setupAxePanel(){
    if (!uiAxeBtn || !uiAxePanel) return;
    setAxePanelFromState();
    uiAxeBtn.addEventListener('click', ()=>{
      uiAxePanel.hidden = !uiAxePanel.hidden;
    });
    document.addEventListener('click', (ev)=>{
      if (!uiAxePanel || uiAxePanel.hidden) return;
      const within = uiAxePanel.contains(ev.target) || uiAxeBtn.contains(ev.target);
      if (!within) uiAxePanel.hidden = true;
    });
    uiAxePanel.addEventListener('change', updateStateFromAxePanel);
  }


  // Função para atualizar contador de nobres no botão
  function updateNobleBadge() {
    const btn = document.getElementById('twInlineBtn');
    if (!btn) return;

    let badge = btn.querySelector('.noble-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'noble-badge';
      btn.appendChild(badge);
    }

    const now = Date.now();
    const nobleCount = cache.filter(a =>
      isNoble(a) &&
      (a.arrival_at || 0) > now &&
      !ignoredCombined.has(String(a.command_id))
    ).length;

    if (nobleCount > 0) {
      // Mostrar número, mas limitar a 99+ para manter badge redondo
      if (nobleCount > 99) {
        badge.textContent = '99+';
        badge.setAttribute('data-count', '99+');
      } else {
        badge.textContent = String(nobleCount);
        badge.removeAttribute('data-count');
      }
      // Garantir que o badge seja sempre circular
      badge.style.width = (nobleCount > 99 ? '20px' : '18px');
      badge.style.height = (nobleCount > 99 ? '20px' : '18px');
      badge.style.minWidth = badge.style.width;
      badge.style.maxWidth = badge.style.width;
      badge.style.padding = '0';
      badge.style.margin = '0';
      badge.style.display = 'flex';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
      badge.removeAttribute('data-count');
    }
  }

  function injectSideButton(){
    if (document.getElementById('twInlineBtn')) return;

    const container=document.querySelector('#questlog_new');
    const btn=document.createElement('div');
    btn.id='twInlineBtn';
    btn.className='quest';
    btn.textContent = 'FL';
    // Mostrar botão apenas se já estiver autenticado
    btn.style.display = isAuthenticatedBE() ? 'flex' : 'none';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.title = 'Painel Central Fellas - Players';

    // Adicionar badge de nobres
    const badge = document.createElement('span');
    badge.className = 'noble-badge';
    badge.style.display = 'none';
    btn.appendChild(badge);

    // Adicionar bolinha de status de rede
    const statusDot = document.createElement('div');
    statusDot.className = 'be-status-dot';
    statusDot.style.cssText = `
      position: absolute;
      top: 1px;
      left: 1px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: #28a745;
      border: 0.5px solid #000;
      z-index: 1002;
    `;
    btn.appendChild(statusDot);

    if (container) container.appendChild(btn);
    else {
      const anchor=document.getElementById('configScript');
      if (anchor) anchor.insertAdjacentElement('afterend', btn);
      else (document.querySelector('#menu_row2, .menu-block, .menu-left') || document.body).appendChild(btn);
    }

    btn.addEventListener('click', async ()=>{
      // VERIFICAÇÃO DE SENHA - versão players
      const unlocked = await requirePasswordBE();
      if (!unlocked) {
        // Se não autenticou, ocultar botão novamente
        btn.style.display = 'none';
        return;
      }

      // Mostrar botão após autenticação bem-sucedida
      btn.style.display = 'flex';

      if (!uiInitialized) {
        createInlineUI();
      } else {
        const isCurrentlyCollapsed = uiBody.classList.contains('hidden');
        setCollapsed(!isCurrentlyCollapsed, true);
        if (isCurrentlyCollapsed) {
            uiWrap.scrollIntoView({ behavior:'smooth', block:'start' });
        }
      }
    });

    // Atualizar contador de nobres periodicamente
    if (__nobleCountUpdateTimer) clearInterval(__nobleCountUpdateTimer);
    __nobleCountUpdateTimer = setInterval(updateNobleBadge, 5000); // A cada 5 segundos
    updateNobleBadge(); // Atualizar imediatamente
  }

  // REMOVIDO: setupBEUnlockHotkey() - não precisa mais digitar "hecto"

  function parseIgnoredIdsFromDoc(doc) {
    const ids = new Set();
    doc.querySelectorAll('#incomings_table input[name^="command_ids["]').forEach(inp => {
        const m = inp.name.match(/^command_ids\[(\d+)\]/);
        if (m) ids.add(m[1]);
    });
    doc.querySelectorAll('#incomings_table [data-command-id]').forEach(el => {
        const v = (el.getAttribute('data-command-id')||'').trim();
        if (/^\d+$/.test(v)) ids.add(v);
    });
    return ids;
  }
  function getIgnoredCacheLocal() {
    try {
      const raw = GM_getValue(IGNORED_CACHE_KEY, null) || localStorage.getItem(IGNORED_CACHE_KEY);
      if (!raw) return { ids: new Set(), ts: 0 };
      const { ids, ts } = JSON.parse(raw);
      return { ids: new Set(ids), ts: ts|0 };
    } catch { return { ids: new Set(), ts: 0 }; }
  }
  function setIgnoredCacheLocal(ids) {
    const payload = JSON.stringify({ ids: [...ids], ts: Date.now() });
    try { GM_setValue(IGNORED_CACHE_KEY, payload); } catch {}
    try { localStorage.setItem(IGNORED_CACHE_KEY, payload); } catch {}
  }
  async function fetchIgnoredIdsAllPages() {
    const base = new URL(location.href);
    base.searchParams.set('screen', 'overview_villages');
    base.searchParams.set('mode', 'incomings');
    base.searchParams.set('type', 'ignored');
    base.searchParams.set('subtype', 'all'); // subtype=all para pegar todos os tipos
    // Não mexer em "group" — usar exatamente o que a URL atual tiver (ou nenhum)

    const all = new Set();
    try {
      let maxPageDetected = null;
      let emptyStreak = 0;
      // Buscar página por página até maxPageDetected (ou até encontrar 2 páginas vazias seguidas)
      for (let page = 0; page < 50; page++) {
        if (maxPageDetected !== null && page > maxPageDetected) {
          dlog(`🛑 [IGNORED] page ${page} > maxPageDetectado ${maxPageDetected}, parando loop.`);
          break;
        }
        try {
          base.searchParams.set('page', String(page));
          const res = await rateLimitFetch(base.toString(), { credentials: 'same-origin' });
          if (!res.ok) break;
          const html = await res.text();
          const doc  = new DOMParser().parseFromString(html, 'text/html');

        // Detectar maxPage a partir da paginação na primeira página
        if (page === 0) {
          let paginationContainer = null;
          const allTds = doc.querySelectorAll('td[align="center"]');
          for (const td of allTds) {
            if (td.querySelector('a.paged-nav-item, a[href*="page="]')) {
              paginationContainer = td;
              break;
            }
          }
          if (!paginationContainer) {
            paginationContainer = doc.querySelector('.paged-nav, .pagination');
          }
          let maxPage = 0;
          if (paginationContainer) {
            const links = paginationContainer.querySelectorAll('a[href*="page="]');
            links.forEach(link => {
              const href = link.getAttribute('href') || link.href || '';
              const m = href.match(/[?&]page=(\d+)/);
              if (m) {
                const num = parseInt(m[1], 10);
                if (!Number.isNaN(num) && num > maxPage) {
                  maxPage = num;
                }
              }
            });
          }
          maxPageDetected = maxPage;
          dlog(`🔎 [IGNORED] maxPageDetectado pelo DOM: ${maxPageDetected}`);
        }

        // Detectar se a página TEM alguma linha de comando na tabela (mesma lógica dos ataques)
        const hasAnyRow = !!doc.querySelector('#incomings_table input[name^="command_ids["], #incomings_table [data-command-id]');
        if (!hasAnyRow) {
          emptyStreak++;
          dlog(`✅ [IGNORED] Página ${page}: nenhuma linha de comando encontrada (emptyStreak=${emptyStreak})`);
          if (emptyStreak >= 2) {
            dlog('✅ [IGNORED] Duas páginas vazias seguidas. Encerrando varredura.');
            break;
          }
          continue;
        }

        // Página tem linhas → coletar IDs normalmente
        const ids  = parseIgnoredIdsFromDoc(doc);
        if (ids.size > 0) {
          emptyStreak = 0;
          ids.forEach(id => all.add(id));
          dlog(`📄 [IGNORED] Página ${page}: ${ids.size} IDs coletados (total: ${all.size})`);
        } else {
          dlog(`⚠️ [IGNORED] Página ${page} tem linhas mas nenhum ID foi encontrado.`);
        }
        } catch {
          break;
        }
      }
    } catch(e) {
      dlog('[IGNORED] erro ao buscar IDs:', e);
    }
    return all;
  }
  async function getIgnoredIdsLocal() {
    // Inicializar cache em memória a partir do storage apenas uma vez
    if (!__ignoredInitDone) {
      const { ids, ts } = getIgnoredCacheLocal();
      __ignoredLastIds = ids;
      __ignoredLastFetchTs = ts;
      __ignoredInitDone = true;
    }

    const now = Date.now();
    const serverConfigured = !!(cfg.serverURL && cfg.authToken);
    const cacheEmpty = __ignoredLastIds.size === 0;
    const cacheExpired = now - __ignoredLastFetchTs >= IGNORED_CACHE_TTL_MS;

    // Se há servidor configurado:
    // - Abas BLOQUEADAS NUNCA fazem fetch de ignorados (nem na primeira vez)
    // - Abas que ainda não são sessão ativa (sem __beSessionActive) também não buscam em background
    // EXCETO: se não está bloqueada e cache está vazio/expirado, permitir fetch uma vez para inicializar
    if (serverConfigured) {
      // Abas bloqueadas: nunca fazer fetch, usar apenas cache existente
      if (__beBlocked) {
        return __ignoredLastIds;
      }

      // Abas não bloqueadas mas não ativas: só fazer fetch se cache nunca foi inicializado (timestamp = 0)
      // Isso permite que a primeira aba faça fetch na primeira vez, mas evita que abas secundárias façam fetch
      // se o cache já foi inicializado por outra aba
      if (!__beSessionActive && !__isSpecialPage) {
        if (__ignoredLastFetchTs === 0) {
          // Permitir fetch apenas se cache nunca foi inicializado (timestamp = 0)
          // (evita que abas secundárias façam fetch se o cache já foi inicializado)
          const fresh = await fetchIgnoredIdsAllPages().catch(() => new Set());
          __ignoredLastIds = fresh;
          __ignoredLastFetchTs = now;
          setIgnoredCacheLocal(fresh);
          return fresh;
        }
        // Usar apenas cache existente, não fazer fetch
        return __ignoredLastIds;
      }
    }

    // Se o cache em memória ainda é recente (mesmo vazio), usar e não bater no jogo.
    if (!cacheExpired) {
      return __ignoredLastIds;
    }

    // Buscar IDs de ignorados desta aba (aba ativa ou sem servidor configurado)
    const fresh = await fetchIgnoredIdsAllPages().catch(() => new Set());
    __ignoredLastIds = fresh;
    __ignoredLastFetchTs = now;
    // Sempre salvar, mesmo que esteja vazio, para respeitar o TTL entre reloads.
    setIgnoredCacheLocal(fresh);
    return fresh;
  }

  function readIgnoredServerCache() {
    try {
      const ids = new Set(JSON.parse(GM_getValue(IGNORED_SERVER_CACHE_KEY, '[]')));
      const at  = Number(GM_getValue(IGNORED_SERVER_CACHE_AT, 0))||0;
      return { ids, at };
    } catch { return { ids:new Set(), at:0 }; }
  }
  function writeIgnoredServerCache(ids) {
    try {
      GM_setValue(IGNORED_SERVER_CACHE_KEY, JSON.stringify([...ids]));
      GM_setValue(IGNORED_SERVER_CACHE_AT, Date.now());
    } catch {}
  }
  async function fetchIgnoredFromServer() {
    // Modo local - sem servidor
    return new Set();
  }
  async function syncIgnoredWithServer() {
    // Modo local - sem servidor
    return;
  }

  async function fetchAttacksFromServer() {
    if (!cfg.serverURL || !cfg.authToken) {
      return [];
    }

    try {
      // Adicionar timestamp para evitar cache do navegador (cache busting)
      const timestamp = Date.now();
      // Usar compressão e timeout menor para download mais rápido
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const p = encodeURIComponent(normalizeName(getLoggedPlayerName()) || '');
      const response = await rateLimitFetch(`${cfg.serverURL}/api/attacks?world=${cfg.world}&version=${encodeURIComponent(VERSION_TEXT)}&player=${p}&_t=${timestamp}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': cfg.authToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Se for erro 426 (versão bloqueada) ou 403 (versão não informada), logar detalhes
        if (response.status === 426 || response.status === 403) {
          const errorData = await response.json().catch(() => ({}));
          dlog(`❌ [Attacks] Erro ${response.status} ao buscar ataques: ${errorData.error || errorData.message || response.statusText}`);
          dlog(`❌ [Attacks] Versão enviada: ${VERSION_TEXT}`);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data.attacks || [];
    } catch (e) {
      if (e.name === 'AbortError') {
        dlog('Timeout ao buscar ataques do servidor (10s)');
      } else {
        dlog('Erro ao buscar ataques do servidor:', e);
      }
      return [];
    }
  }
  async function refreshIgnoredCombined() {
    // Modo local - apenas dados locais
    const loc = await getIgnoredIdsLocal();

    // Verificar se os IDs mudaram antes de atualizar (evita re-renderizações desnecessárias)
    const newIdsStr = Array.from(loc).sort().join(',');
    const currentIdsStr = Array.from(ignoredCombined).sort().join(',');
    if (newIdsStr === currentIdsStr && ignoredCombined.size === loc.size) {
      // IDs não mudaram, não precisa atualizar nem re-renderizar
      return;
    }

    ignoredCombined = new Set();
    loc.forEach(id => ignoredCombined.add(String(id)));
    document.documentElement.classList.toggle('tw-show-ignored', !!cfg.showIgnored);
    if (uiInitialized) renderTable();
  }

  function isVisibleAttack(a){
    return cfg.showIgnored || !ignoredCombined.has(String(a.command_id));
  }

  function getAxeCategory(a){
    if (isNoble(a)) return 'noble';
    if (isNormal(a)) return 'normal';
    const ax = getAxeType(a);
    if (ax==='small') return 'small';
    if (ax==='medium') return 'medium';
    if (ax==='large') return 'large';
    if (ax==='small_medium') return 'small_medium';
    return 'normal';
  }

  function matchesAxeFilter(a){
    if (axeSelected.has('all') || axeSelected.size===0) return true;
    const cat = getAxeCategory(a);
    return axeSelected.has(cat);
  }

  function countersFor(list){
    let normal=0, small=0, medium=0, large=0, small_medium=0, noble=0, wt=0, support=0, ignored=0;
    for (const a of list){
      if (ignoredCombined.has(String(a.command_id))) { ignored++; }
      if (isSupport(a)) { support++; continue; }
      if (a.watchtower) wt++;
      if (isNoble(a)) { noble++; continue; }
      if (isNormal(a)) { normal++; continue; }
      const ax = getAxeType(a);
      if (ax==='small') small++;
      else if (ax==='medium') medium++;
      else if (ax==='large')  large++;
      else if (ax==='small_medium') small_medium++;
    }
    return { normal, small, medium, large, small_medium, noble, wt, support, ignored, total: list.length };
  }

  function chipsHTML(cnt){
    const base = DEFAULT_AXE_ICON;
    const icoSmall  = buildIconVariant(base,'small');
    const icoMedium = buildIconVariant(base,'medium');
    const icoLarge  = buildIconVariant(base,'large');
    const icoNormal = base;
    return `<span class="tw-axe-ctr" title="Normal"><img src="${esc(icoNormal)}"><span class="num">${cnt.normal}</span></span><span class="tw-axe-ctr" title="Small"><img src="${esc(icoSmall)}"><span class="num">${cnt.small}</span></span><span class="tw-axe-ctr" title="Medium"><img src="${esc(icoMedium)}"><span class="num">${cnt.medium}</span></span><span class="tw-axe-ctr" title="Small/Medium (provisório)"><span class="stack" style="display:inline-flex;gap:2px;align-items:center"><img src="${esc(icoSmall)}"><img src="${esc(icoMedium)}"></span><span class="num">${cnt.small_medium}</span></span><span class="tw-axe-ctr" title="Large"><img src="${esc(icoLarge)}"><span class="num">${cnt.large}</span></span><span class="tw-axe-ctr" title="Nobre"><img src="${esc(NOBLE_ICON)}" onerror="this.style.display='none';this.parentElement.insertAdjacentText('afterbegin','👑');"><span class="num">${cnt.noble}</span></span><span class="tw-axe-ctr" title="Suporte/Apoio"><img src="${esc(SUPPORT_ICON)}" alt="Suporte" onerror="this.style.display='none';this.parentElement.insertAdjacentText('afterbegin','🛡️');"><span class="num">${cnt.support}</span></span><span class="tw-axe-ctr" title="Watchtower">👁 <span class="num">${cnt.wt}</span></span>${cnt.ignored > 0 ? `<span class="tw-axe-ctr" title="Ataques Ignorados" style="background:#ffecb3;color:#333">🚫 <span class="num">${cnt.ignored}</span></span>` : ''}`;
  }

  // ===== FUNÇÕES PARA LINKS DE ALDEIAS =====

  // Função para obter ID da aldeia atual da URL
  function getCurrentVillageId() {
    try {
      const params = new URLSearchParams(location.search);
      const villageId = params.get('village');
      return villageId || null;
    } catch (e) {
      return null;
    }
  }

  // Função para extrair coordenadas do nome da aldeia
  function extractCoordsFromVillageName(villageName) {
    if (!villageName) return null;
    // Formato: "Aldeia ? (497|503) K54" ou "497|503" ou "#ERROR!404 | Village Not Found (497|503) K54"
    const match = String(villageName).match(/(\d+)\|(\d+)/);
    if (match) {
      return { x: parseInt(match[1]), y: parseInt(match[2]) };
    }
    return null;
  }

  // Função para buscar ID da aldeia pelas coordenadas
  function findVillageIdByCoords(x, y) {
    if (!MUNDO_DADOS.loaded || !MUNDO_DADOS.aldeias) {
      dlog(`[Links] Dados do mundo não carregados ainda para buscar aldeia: ${x}|${y}`);
      return null;
    }

    // Buscar aldeia com coordenadas exatas
    const aldeia = MUNDO_DADOS.aldeias.find(a => a.x === x && a.y === y);
    if (aldeia) {
      dlog(`[Links] Aldeia encontrada: ${x}|${y} -> ID: ${aldeia.id}`);
      return aldeia.id;
    }
    dlog(`[Links] Aldeia não encontrada: ${x}|${y} (${MUNDO_DADOS.aldeias.length} aldeias no mapa)`);
    return null;
  }

  // Função para construir link da aldeia
  function buildVillageLink(villageId, coords) {
    const currentVillageId = getCurrentVillageId() || '7309'; // Fallback
    const baseUrl = location.origin + location.pathname;
    const params = new URLSearchParams();
    params.set('village', currentVillageId);
    params.set('screen', 'info_village');
    params.set('id', villageId);
    const hash = coords ? `#${coords.x};${coords.y}` : '';
    return `${baseUrl}?${params.toString()}${hash}`;
  }

  function updateStats(rows){
    if (!uiStats) return;
    const cnt = countersFor(rows);

    // Contar ignorados de TODO o cache (não apenas rows filtrados)
    const now = Date.now();
    const totalIgnored = cache.filter(a => (a.arrival_at||0) > now && ignoredCombined.has(String(a.command_id))).length;

    uiStats.innerHTML = `<div class="tw-badge" title="Normal"><img src="${esc(DEFAULT_AXE_ICON)}"><strong>${cnt.normal}</strong></div><div class="tw-badge" title="Small"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'small'))}"><strong>${cnt.small}</strong></div><div class="tw-badge" title="Medium"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'medium'))}"><strong>${cnt.medium}</strong></div><div class="tw-badge" title="Small/Medium (provisório)"><span class="stack" style="display:inline-flex;gap:2px;align-items:center"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'small'))}"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'medium'))}"></span><strong>${cnt.small_medium}</strong></div><div class="tw-badge" title="Large"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'large'))}"><strong>${cnt.large}</strong></div><div class="tw-badge" title="Nobre"><img src="${esc(NOBLE_ICON)}" onerror="this.style.display='none';this.parentElement.insertAdjacentText('afterbegin','👑');"><strong>${cnt.noble}</strong></div><div class="tw-badge" title="Suporte/Apoio"><img src="${esc(SUPPORT_ICON)}" alt="Suporte" onerror="this.style.display='none';this.parentElement.insertAdjacentText('afterbegin','🛡️');"><strong>${cnt.support}</strong></div><div class="tw-badge" title="Watchtower">👁 <strong>${cnt.wt}</strong></div>${totalIgnored > 0 ? `<div class="tw-badge" title="Ataques Ignorados" style="background:#ffecb3;color:#333">🚫 <strong>${totalIgnored}</strong></div>` : ''}`;
  }

  // Função para renderizar minimapa
  // Estado do minimapa (zoom e pan)
  let mapaState = null;
  let mapDragState = { isDragging: false, dragStartX: undefined, dragStartY: undefined };
  let mapAttacksWithCoords = [];
  let mapWorldBounds = null;

  // Dados do mundo (aldeias, jogadores, tribos)
  let MUNDO_DADOS = {
    aldeias: [],
    jogadoresMap: new Map(),
    tribosMap: new Map(),
    aldeiasMap: new Map(),
    loaded: false
  };

  // Sistema de cores para tribos de interesse
  const TRIBES_CONFIG_KEY = 'tw_map_tribes_config';
  let tribesConfig = new Map(); // Map<triboId, {color, name}>

  function loadTribesConfig() {
    try {
      const saved = GM_getValue(TRIBES_CONFIG_KEY, '{}');
      const config = JSON.parse(saved);
      tribesConfig = new Map(Object.entries(config));
      dlog(`Configuração de tribos carregada: ${tribesConfig.size} tribos`);
    } catch (e) {
      dlog('Erro ao carregar configuração de tribos:', e);
      tribesConfig = new Map();
    }
  }

  function saveTribesConfig() {
    try {
      const config = Object.fromEntries(tribesConfig);
      GM_setValue(TRIBES_CONFIG_KEY, JSON.stringify(config));
      dlog('Configuração de tribos salva');
    } catch (e) {
      dlog('Erro ao salvar configuração de tribos:', e);
    }
  }

  const CONTINENT_SIZE = 100; // Cada continente tem 100x100 coordenadas

  // Função para carregar dados do mundo
  // Atualização: Os dados são carregados do servidor do Tribal Wars (village.txt, player.txt, ally.txt)
  // Os dados são cacheados por 1 hora. O cache é usado para evitar requisições desnecessárias.
  // O mapa sempre tenta carregar automaticamente ao ser exibido.

  async function loadWorldData() {
    // Cache de 12 horas (player/ally/village mudam ~1x ao dia)
    const CACHE_KEY = `world_data_${cfg.world}`;
    const CACHE_TIMESTAMP_KEY = `world_data_timestamp_${cfg.world}`;
    const CACHE_DURATION = 12 * 60 * 60 * 1000; // 12 horas

    const cachedData = GM_getValue(CACHE_KEY);
    const cacheTimestamp = GM_getValue(CACHE_TIMESTAMP_KEY, 0);
    const now = Date.now();

    // Se já foi carregado nesta sessão, não recarregar
    if (MUNDO_DADOS.loaded) {
      // Mas verificar se o cache expirou para forçar recarregamento
      if (cachedData && (now - cacheTimestamp) < CACHE_DURATION) {
        return true; // Cache válido, usar dados já carregados
      }
      // Cache expirado, limpar e recarregar
      MUNDO_DADOS.loaded = false;
    }

    // Se tem cache válido e recente, usar
    if (cachedData && (now - cacheTimestamp) < CACHE_DURATION) {
      try {
        const data = JSON.parse(cachedData);
        
        // 1) Parse aldeias
        const aldeiasRaw = data.aldeias || [];
        const aldeiasParsed = [];
        const aldeiasLen = aldeiasRaw.length;
        for (let i = 0; i < aldeiasLen; i++) {
          const item = aldeiasRaw[i];
          if (item) {
            if (!Array.isArray(item)) {
              aldeiasParsed.push(item);
            } else if (item.length >= 7) {
              const xVal = item[2];
              const yVal = item[3];
              const pVal = item[5];
              const prVal = item[6];
              aldeiasParsed.push({
                id: item[0],
                nome: item[1] || '',
                x: typeof xVal === 'number' ? xVal : (parseInt(xVal) || 0),
                y: typeof yVal === 'number' ? yVal : (parseInt(yVal) || 0),
                idJogador: item[4] || '0',
                pontos: typeof pVal === 'number' ? pVal : (parseInt(pVal) || 0),
                pontos_rank: typeof prVal === 'number' ? prVal : (parseInt(prVal) || 0)
              });
            }
          }
        }
        MUNDO_DADOS.aldeias = aldeiasParsed;

        // 2) Parse jogadores
        const jogadoresMap = new Map();
        const jogadoresRaw = data.jogadores || [];
        const jogadoresLen = jogadoresRaw.length;
        for (let i = 0; i < jogadoresLen; i++) {
          const item = jogadoresRaw[i];
          if (Array.isArray(item)) {
            if (item.length === 2 && typeof item[1] === 'object') {
              const player = item[1];
              jogadoresMap.set(item[0], player);
            } else if (item.length >= 6) {
              const aVal = item[3];
              const pVal = item[4];
              const prVal = item[5];
              jogadoresMap.set(item[0], {
                id: item[0],
                nome: item[1] || '',
                idTribo: item[2] || '0',
                aldeias: typeof aVal === 'number' ? aVal : (parseInt(aVal) || 0),
                pontos: typeof pVal === 'number' ? pVal : (parseInt(pVal) || 0),
                pontos_rank: typeof prVal === 'number' ? prVal : (parseInt(prVal) || 0)
              });
            }
          }
        }
        MUNDO_DADOS.jogadoresMap = jogadoresMap;

        // 3) Parse tribos
        const tribosMap = new Map();
        const tribosRaw = data.tribos || [];
        const tribosLen = tribosRaw.length;
        for (let i = 0; i < tribosLen; i++) {
          const item = tribosRaw[i];
          if (Array.isArray(item)) {
            if (item.length === 2 && typeof item[1] === 'object') {
              const tribo = item[1];
              tribosMap.set(item[0], tribo);
            } else if (item.length >= 7) {
              const mVal = item[3];
              const aVal = item[4];
              const pVal = item[5];
              const prVal = item[6];
              tribosMap.set(item[0], {
                id: item[0],
                tag: item[1] || '',
                nome: item[2] || '',
                membros: typeof mVal === 'number' ? mVal : (parseInt(mVal) || 0),
                aldeias: typeof aVal === 'number' ? aVal : (parseInt(aVal) || 0),
                pontos: typeof pVal === 'number' ? pVal : (parseInt(pVal) || 0),
                pontos_rank: typeof prVal === 'number' ? prVal : (parseInt(prVal) || 0)
              });
            }
          }
        }
        MUNDO_DADOS.tribosMap = tribosMap;

        // 4) Reconstruir aldeiasMap com coordenadas como chave
        MUNDO_DADOS.aldeiasMap = new Map();
        for (let i = 0; i < aldeiasLen; i++) {
          const v = aldeiasParsed[i];
          if (v) {
            MUNDO_DADOS.aldeiasMap.set(v.x + '|' + v.y, v);
          }
        }

        MUNDO_DADOS.loaded = true;
        dlog(`Dados do mundo carregados do cache (${Math.floor((now - cacheTimestamp) / 1000)}s atrás)`);
        return true;
      } catch (e) {
        dlog('Erro ao ler cache, recarregando do servidor...', e);
        MUNDO_DADOS.loaded = false;
      }
    }

    try {
      const worldId = cfg.world;
      const baseUrl = `https://${worldId}.tribalwars.com.br/map`;

      dlog('Carregando dados do mundo...');

      // Tentar carregar os arquivos do mapa
      const [villageData, playerData, allyData] = await Promise.all([
        fetch(`${baseUrl}/village.txt`).then(r => r.ok ? r.text() : null).catch(() => null),
        fetch(`${baseUrl}/player.txt`).then(r => r.ok ? r.text() : null).catch(() => null),
        fetch(`${baseUrl}/ally.txt`).then(r => r.ok ? r.text() : null).catch(() => null)
      ]);

      if (villageData) {
        // Parse village.txt: id, name, x, y, idJogador, pontos, pontos_rank
        const villages = [];
        villageData.split('\n').forEach(line => {
          const parts = line.split(',');
          if (parts.length >= 7) {
            villages.push({
              id: parts[0],
              nome: parts[1] || '',
              x: parseInt(parts[2]) || 0,
              y: parseInt(parts[3]) || 0,
              idJogador: parts[4] || '0',
              pontos: parseInt(parts[5]) || 0,
              pontos_rank: parseInt(parts[6]) || 0
            });
          }
        });
        MUNDO_DADOS.aldeias = villages;
        // Consistência com Liderança: chave por coordenadas "x|y" (lookup rápido)
        MUNDO_DADOS.aldeiasMap = new Map();
        villages.forEach(v => {
          const coordKey = `${v.x}|${v.y}`;
          MUNDO_DADOS.aldeiasMap.set(coordKey, v);
        });
        dlog(`Carregadas ${villages.length} aldeias`);
      }

      if (playerData) {
        // Parse player.txt: id, nome, idTribo, aldeias, pontos, pontos_rank
        const players = [];
        playerData.split('\n').forEach(line => {
          const parts = line.split(',');
          if (parts.length >= 6) {
            players.push({
              id: parts[0],
              nome: normalizeName(parts[1] || ''), // Normalizar nome (remover "+" e normalizar espaços)
              idTribo: parts[2] || '0',
              aldeias: parseInt(parts[3]) || 0,
              pontos: parseInt(parts[4]) || 0,
              pontos_rank: parseInt(parts[5]) || 0
            });
          }
        });
        players.forEach(p => {
          MUNDO_DADOS.jogadoresMap.set(p.id, p);
        });
        dlog(`Carregados ${players.length} jogadores`);
      }

      if (allyData) {
        // Parse ally.txt: id, tag, nome, membros, aldeias, pontos, pontos_rank
        const tribes = [];
        allyData.split('\n').forEach(line => {
          const parts = line.split(',');
          if (parts.length >= 7) {
            tribes.push({
              id: parts[0],
              tag: normalizeName(parts[1] || ''), // Normalizar tag (remover "+" e normalizar espaços)
              nome: normalizeName(parts[2] || ''), // Normalizar nome (remover "+" e normalizar espaços)
              membros: parseInt(parts[3]) || 0,
              aldeias: parseInt(parts[4]) || 0,
              pontos: parseInt(parts[5]) || 0,
              pontos_rank: parseInt(parts[6]) || 0
            });
          }
        });
        tribes.forEach(t => {
          MUNDO_DADOS.tribosMap.set(t.id, t);
        });
        dlog(`Carregadas ${tribes.length} tribos`);
      }

      MUNDO_DADOS.loaded = true;

      // Salvar no cache (formato compactado para evitar estouro de 64MB)
      const cacheData = {
        aldeias: MUNDO_DADOS.aldeias.map(v => [
          v.id,
          v.nome,
          v.x,
          v.y,
          v.idJogador,
          v.pontos,
          v.pontos_rank
        ]),
        jogadores: Array.from(MUNDO_DADOS.jogadoresMap.values()).map(p => [
          p.id,
          p.nome,
          p.idTribo,
          p.aldeias,
          p.pontos,
          p.pontos_rank
        ]),
        tribos: Array.from(MUNDO_DADOS.tribosMap.values()).map(t => [
          t.id,
          t.tag,
          t.nome,
          t.membros,
          t.aldeias,
          t.pontos,
          t.pontos_rank
        ])
      };
      GM_setValue(CACHE_KEY, JSON.stringify(cacheData));
      GM_setValue(CACHE_TIMESTAMP_KEY, now);

      dlog('Dados do mundo carregados com sucesso do servidor');
      return true;
    } catch (e) {
      dlog('Erro ao carregar dados do mundo:', e);
      return false;
    }
  }

  // Função para desenhar grades dos continentes
  function desenharGradesContinentes(ctx, canvas, area, sxCanvas, syCanvas) {
    ctx.save();

    ctx.strokeStyle = '#000000'; // Linhas pretas/escuras
    ctx.lineWidth = 1.5; // Mais grossas
    ctx.fillStyle = '#ffffff'; // Labels brancos para contraste
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Calcular limites dos continentes visíveis
    const minKx = Math.floor(area.x_min / CONTINENT_SIZE);
    const maxKx = Math.floor(area.x_max / CONTINENT_SIZE);
    const minKy = Math.floor(area.y_min / CONTINENT_SIZE);
    const maxKy = Math.floor(area.y_max / CONTINENT_SIZE);

    // Desenhar linhas verticais (separando continentes K)
    for (let kx = minKx; kx <= maxKx; kx++) {
      const x = kx * CONTINENT_SIZE;
      if (x >= area.x_min && x <= area.x_max) {
        const canvasX = (x - area.x_min) * sxCanvas;
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, canvas.height);
        ctx.stroke();
      }
    }

    // Desenhar linhas horizontais (separando continentes K)
    for (let ky = minKy; ky <= maxKy; ky++) {
      const y = ky * CONTINENT_SIZE;
      if (y >= area.y_min && y <= area.y_max) {
        const canvasY = (y - area.y_min) * syCanvas;
        ctx.beginPath();
        ctx.moveTo(0, canvasY);
        ctx.lineTo(canvas.width, canvasY);
        ctx.stroke();
      }
    }

    // Desenhar labels dos continentes (K)
    for (let ky = minKy; ky <= maxKy; ky++) {
      for (let kx = minKx; kx <= maxKx; kx++) {
        const centerX = (kx * CONTINENT_SIZE) + (CONTINENT_SIZE / 2);
        const centerY = (ky * CONTINENT_SIZE) + (CONTINENT_SIZE / 2);

        // Verificar se o centro do continente está na área visível
        if (centerX >= area.x_min && centerX <= area.x_max &&
            centerY >= area.y_min && centerY <= area.y_max) {

          const canvasX = (centerX - area.x_min) * sxCanvas;
          const canvasY = (centerY - area.y_min) * syCanvas;

          // Só mostrar label se o continente for grande o suficiente
          const continentWidth = CONTINENT_SIZE * sxCanvas;
          const continentHeight = CONTINENT_SIZE * syCanvas;

          if (continentWidth > 30 && continentHeight > 20) {
            ctx.fillText(`K${ky}${kx}`, canvasX, canvasY);
          }
        }
      }
    }

    ctx.restore();
  }

  // Função para desenhar aldeias no mapa
  function desenharAldeias(ctx, canvas, area, sxCanvas, syCanvas) {
    if (!MUNDO_DADOS.loaded || !MUNDO_DADOS.aldeias.length) return;

    const aldeiasNaArea = MUNDO_DADOS.aldeias.filter(a =>
      a.x >= area.x_min && a.x < area.x_max &&
      a.y >= area.y_min && a.y < area.y_max
    );

    // Cores padrão (pode ser configurável no futuro)
    const cores = {
      propria: '#0000FF',    // Azul
      aliada: '#00FF00',     // Verde
      inimiga: '#FF0000',    // Vermelho
      barbara: '#888888',    // Cinza
      outra: '#FFA500'       // Laranja
    };

    // Por enquanto, vamos usar cores simples baseadas na tribo
    // (em um futuro pode adicionar sistema de diplomacia)
    const idPropriaTribo = null; // Não temos como detectar ainda

    for (const aldeia of aldeiasNaArea) {
      const cx = (aldeia.x - area.x_min) * sxCanvas;
      const cy = (aldeia.y - area.y_min) * syCanvas;

      const jogador = MUNDO_DADOS.jogadoresMap.get(aldeia.idJogador);

      // Determinar cor
      let fillColor = cores.outra;
      let strokeColor = '#333';
      let strokeWidth = 0.5;

      if (!jogador || jogador.idTribo === '0') {
        fillColor = cores.barbara;
      } else {
        // Verificar se a tribo está nas configurações de interesse
        const triboConfig = tribesConfig.get(jogador.idTribo);
        if (triboConfig) {
          fillColor = triboConfig.color || cores.outra;
          strokeColor = '#000';
          strokeWidth = 1.5; // Destacar tribos de interesse
        } else {
          fillColor = cores.outra; // Por padrão, outras tribos
        }
      }

      // Tamanho do ponto baseado no zoom
      const tam = mapaState.tamanho < 50 ? 5 : (mapaState.tamanho < 100 ? 4 : 3);

      // Desenhar aldeia
      ctx.fillStyle = fillColor;
      ctx.fillRect(cx, cy, tam, tam);

      // Contorno (mais forte para tribos de interesse)
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.strokeRect(cx, cy, tam, tam);
    }

    return aldeiasNaArea; // Retornar para usar em tooltips
  }

  function initializeMapState(attacksWithCoords) {
    if (!attacksWithCoords || attacksWithCoords.length === 0) return;

    // Calcular limites do mundo
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    attacksWithCoords.forEach(({ origin, target }) => {
      minX = Math.min(minX, origin.x, target.x);
      maxX = Math.max(maxX, origin.x, target.x);
      minY = Math.min(minY, origin.y, target.y);
      maxY = Math.max(maxY, origin.y, target.y);
    });

    // Adicionar padding
    const paddingX = (maxX - minX) * 0.15 || 20;
    const paddingY = (maxY - minY) * 0.15 || 20;

    mapWorldBounds = {
      x_min: minX - paddingX,
      y_min: minY - paddingY,
      x_max: maxX + paddingX,
      y_max: maxY + paddingY
    };

    // Inicializar estado do mapa se ainda não existe
    if (!mapaState) {
      const mapWidth = mapWorldBounds.x_max - mapWorldBounds.x_min;
      const mapHeight = mapWorldBounds.y_max - mapWorldBounds.y_min;
      const centerX = mapWorldBounds.x_min + mapWidth / 2;
      const centerY = mapWorldBounds.y_min + mapHeight / 2;
      const initialSize = Math.max(mapWidth, mapHeight) * 1.2; // Começar com zoom out

      mapaState = {
        x: centerX - initialSize / 2,
        y: centerY - initialSize / 2,
        tamanho: initialSize
      };
    }

    // Não forçar limites rígidos na inicialização - permitir movimento livre depois
  }

  function getMapScales(canvas) {
    const rect = canvas.getBoundingClientRect();
    const sxCanvas = canvas.width / mapaState.tamanho;
    const syCanvas = canvas.height / mapaState.tamanho;
    const sxCss = rect.width / mapaState.tamanho;
    const syCss = rect.height / mapaState.tamanho;
    return { rect, sxCanvas, syCanvas, sxCss, syCss };
  }

  function worldToCanvas(x, y, canvas) {
    const { sxCanvas, syCanvas } = getMapScales(canvas);
    const area = {
      x_min: mapaState.x,
      y_min: mapaState.y,
      x_max: mapaState.x + mapaState.tamanho,
      y_max: mapaState.y + mapaState.tamanho
    };
    const canvasX = (x - area.x_min) * sxCanvas;
    const canvasY = (y - area.y_min) * syCanvas;
    return { x: canvasX, y: canvasY };
  }

  function canvasToWorld(canvasX, canvasY, canvas) {
    const { sxCss, syCss } = getMapScales(canvas);
    const { rect } = getMapScales(canvas);
    const mx = canvasX - rect.left;
    const my = canvasY - rect.top;
    const worldX = mapaState.x + (mx / sxCss);
    const worldY = mapaState.y + (my / syCss);
    return { x: worldX, y: worldY };
  }

  function clampMapBounds() {
    if (!mapWorldBounds) {
      // Se não há limites definidos, permitir movimento livre (limites do mundo)
      const WORLD_MAX = 1000; // Limite máximo padrão do mundo Tribal Wars
      mapaState.x = Math.max(0, Math.min(WORLD_MAX - mapaState.tamanho, mapaState.x));
      mapaState.y = Math.max(0, Math.min(WORLD_MAX - mapaState.tamanho, mapaState.y));
      return;
    }
    // Permitir movimento mais livre, com margem para explorar além dos ataques
    const margin = mapaState.tamanho * 0.5; // Margem de 50% do tamanho visível
    mapaState.x = Math.max(mapWorldBounds.x_min - margin, Math.min(mapWorldBounds.x_max + margin - mapaState.tamanho, mapaState.x));
    mapaState.y = Math.max(mapWorldBounds.y_min - margin, Math.min(mapWorldBounds.y_max + margin - mapaState.tamanho, mapaState.y));
    mapaState.tamanho = Math.max(10, Math.min(500, mapaState.tamanho));
  }

  async function renderMinimap() {
    const mapCanvas = document.getElementById('tw-minimap');
    if (!mapCanvas) return;

    const ctx = mapCanvas.getContext('2d');
    if (!ctx) return;

    // Ajustar tamanho do canvas para o tamanho de exibição
    const rect = mapCanvas.getBoundingClientRect();
    if (mapCanvas.width !== rect.width || mapCanvas.height !== rect.height) {
      mapCanvas.width = rect.width;
      mapCanvas.height = rect.height;
    }

    const now = Date.now();
    const ft = (filters.type?.value || '').toLowerCase();
    const fta = (filters.target?.value || '').toLowerCase();
    const fde = (filters.defender?.value || '').toLowerCase();
    const fori = (filters.origin?.value || '').toLowerCase();
    const fatk = (filters.attacker?.value || '').toLowerCase();
    const fmin = parseInt(filters.time?.value || '0', 10);

    // Filtrar ataques
    const filteredAttacks = cache
      .filter(a => (a.arrival_at || 0) > now)
      .filter(isVisibleAttack)
      .filter(a => cfg.supportsVisible || !isSupport(a))
      .filter(matchesAxeFilter)
      .filter(a => !ft || (a.type || '').toLowerCase().includes(ft))
      .filter(a => !fta || (a.target || '').toLowerCase().includes(fta))
      .filter(a => !fde || (a.defender || '').toLowerCase().includes(fde))
      .filter(a => !fori || (a.origin || '').toLowerCase().includes(fori))
      .filter(a => !fatk || (a.attacker || '').toLowerCase().includes(fatk))
      .filter(a => !fmin || ((a.arrival_at - now) > 0 && (a.arrival_at - now) <= fmin * 60 * 1000));

    // Extrair coordenadas válidas
    const attacksWithCoords = filteredAttacks
      .map(a => {
        const origin = normalizeOriginCoords(a.origin);
        const target = normalizeTargetCoords(a.target);
        if (!origin || !target) return null;
        return { attack: a, origin, target };
      })
      .filter(x => x !== null);

    mapAttacksWithCoords = attacksWithCoords;

    if (attacksWithCoords.length === 0) {
      ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
      ctx.fillStyle = '#666';
      ctx.font = '16px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Nenhum ataque com coordenadas válidas', mapCanvas.width / 2, mapCanvas.height / 2);
      return;
    }

    // Inicializar estado do mapa se necessário
    initializeMapState(attacksWithCoords);
    if (!mapaState) return;

    // Limpar canvas
    ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);

    // Carregar dados do mundo automaticamente (força recarregamento se necessário)
    try {
      await loadWorldData();
    } catch (e) {
      dlog('Erro ao carregar dados do mundo:', e);
    }

    // Área visível
    const area = {
      x_min: mapaState.x,
      y_min: mapaState.y,
      x_max: mapaState.x + mapaState.tamanho,
      y_max: mapaState.y + mapaState.tamanho
    };

    const { sxCanvas, syCanvas } = getMapScales(mapCanvas);

    // Desenhar grades dos continentes (fundo)
    desenharGradesContinentes(ctx, mapCanvas, area, sxCanvas, syCanvas);

    // Desenhar aldeias
    const aldeiasVisiveis = desenharAldeias(ctx, mapCanvas, area, sxCanvas, syCanvas);

    // Desenhar raio de nobres (se habilitado)
    if (window.__nobleRadiusStatePlayers && window.__nobleRadiusStatePlayers.enabled && window.drawNobleRadiusPlayers) {
      window.drawNobleRadiusPlayers(ctx, mapCanvas, area, sxCanvas, syCanvas);
    }

    // Verificar filtros do mapa
    const showNoble = document.getElementById('map-filter-noble')?.checked ?? true;
    const showSmall = document.getElementById('map-filter-small')?.checked ?? true;
    const showMedium = document.getElementById('map-filter-medium')?.checked ?? true;
    const showLarge = document.getElementById('map-filter-large')?.checked ?? true;
    const showNormal = document.getElementById('map-filter-normal')?.checked ?? true;
    const showSupport = document.getElementById('map-filter-support')?.checked ?? true;

    // Desenhar linhas de ataques
    attacksWithCoords.forEach(({ attack, origin, target }) => {
      // Verificar filtro por tipo
      const axeType = getAxeCategory(attack);
      if (isNoble(attack) && !showNoble) return;
      if (isSupport(attack) && !showSupport) return;
      if (axeType === 'small' && !showSmall) return;
      if (axeType === 'medium' && !showMedium) return;
      if (axeType === 'large' && !showLarge) return;
      if (axeType === 'normal' && !showNormal) return;

      // Verificar se está na área visível
      if (origin.x < area.x_min || origin.x >= area.x_max || origin.y < area.y_min || origin.y >= area.y_max ||
          target.x < area.x_min || target.x >= area.x_max || target.y < area.y_min || target.y >= area.y_max) {
        return; // Fora da área visível
      }

      const originCanvas = worldToCanvas(origin.x, origin.y, mapCanvas);
      const targetCanvas = worldToCanvas(target.x, target.y, mapCanvas);

      // Cor baseada no tipo
      let color = '#888';
      if (isNoble(attack)) color = '#dc3545'; // Vermelho para nobres
      else if (isSupport(attack)) color = '#ffc107'; // Amarelo para apoio
      else if (axeType === 'large') color = '#dc3545'; // Vermelho para large
      else if (axeType === 'medium') color = '#8b4513'; // Marrom para medium
      else if (axeType === 'small') color = '#28a745'; // Verde para small
      else color = '#6c757d'; // Cinza para normal

      // Desenhar linha (mais destacada)
      ctx.beginPath();
      ctx.moveTo(originCanvas.x, originCanvas.y);
      ctx.lineTo(targetCanvas.x, targetCanvas.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3; // Mais grossa
      ctx.globalAlpha = 0.9; // Mais opaca
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      // Desenhar pontos
      const pointSize = mapaState.tamanho < 50 ? 4 : (mapaState.tamanho < 100 ? 3 : 2);

      // Origem
      ctx.fillStyle = color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(originCanvas.x, originCanvas.y, pointSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Destino
      ctx.beginPath();
      ctx.arc(targetCanvas.x, targetCanvas.y, pointSize + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    // Desenhar legenda
    ctx.fillStyle = '#333';
    ctx.font = '12px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const legendText = `Ataques: ${attacksWithCoords.length} | Região: ${area.x_min.toFixed(0)},${area.y_min.toFixed(0)} - ${area.x_max.toFixed(0)},${area.y_max.toFixed(0)} | Zoom: ${(150 / mapaState.tamanho).toFixed(1)}x`;
    ctx.fillText(legendText, 10, 10);
  }

  let mapInteractionsSetup = false;

  function setupMapInteractions() {
    const mapCanvas = document.getElementById('tw-minimap');
    if (!mapCanvas || mapInteractionsSetup) return;

    mapInteractionsSetup = true;
    const canvas = mapCanvas;

    // Wheel event (zoom)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { rect } = getMapScales(canvas);
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { x: worldX, y: worldY } = canvasToWorld(e.clientX, e.clientY, canvas);

      const fator = e.deltaY > 0 ? 1.25 : 0.8;
      const novo = Math.max(10, Math.min(500, mapaState.tamanho * fator));

      mapaState.x = worldX - (mx / rect.width) * novo;
      mapaState.y = worldY - (my / rect.height) * novo;
      mapaState.tamanho = novo;
      clampMapBounds();
      renderMinimap();
    }, { passive: false });

    // Mouse down (iniciar drag)
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Apenas botão esquerdo
      mapDragState.isDragging = false;
      mapDragState.dragStartX = e.clientX;
      mapDragState.dragStartY = e.clientY;
      canvas.style.cursor = 'grabbing';
    });

    // Mouse move (drag + tooltip)
    canvas.addEventListener('mousemove', (e) => {
      // Drag handling
      if (mapDragState.dragStartX !== undefined) {
        const dx = e.clientX - mapDragState.dragStartX;
        const dy = e.clientY - mapDragState.dragStartY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          mapDragState.isDragging = true;
        }

        if (mapDragState.isDragging) {
          const { sxCss, syCss } = getMapScales(canvas);
          mapaState.x -= dx / sxCss;
          mapaState.y -= dy / syCss;
          clampMapBounds();
          mapDragState.dragStartX = e.clientX;
          mapDragState.dragStartY = e.clientY;
          renderMinimap().catch(e => dlog('Erro:', e));
          // Esconder tooltip durante drag
          const tooltip = document.getElementById('map-tooltip');
          if (tooltip) tooltip.style.display = 'none';
          return;
        }
      }

      // Tooltip handling (só quando não está arrastando)
      if (!mapDragState.isDragging && mapaState) {
        const { rect } = getMapScales(canvas);
        const { x: worldX, y: worldY } = canvasToWorld(e.clientX, e.clientY, canvas);

        // Buscar aldeia mais próxima (dentro de 2 unidades de distância)
        let nearestVillage = null;
        let minDist = 2;

        if (MUNDO_DADOS.loaded && MUNDO_DADOS.aldeias.length) {
          const area = {
            x_min: mapaState.x,
            y_min: mapaState.y,
            x_max: mapaState.x + mapaState.tamanho,
            y_max: mapaState.y + mapaState.tamanho
          };

          const aldeiasNaArea = MUNDO_DADOS.aldeias.filter(a =>
            a.x >= area.x_min && a.x < area.x_max &&
            a.y >= area.y_min && a.y < area.y_max
          );

          for (const aldeia of aldeiasNaArea) {
            const dist = Math.hypot(aldeia.x - worldX, aldeia.y - worldY);
            if (dist < minDist) {
              minDist = dist;
              nearestVillage = aldeia;
            }
          }
        }

        // Mostrar/esconder tooltip
        let tooltip = document.getElementById('map-tooltip');
        if (nearestVillage) {
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'map-tooltip';
            tooltip.style.cssText = `
              position: fixed;
              background: rgba(0, 0, 0, 0.9);
              color: white;
              padding: 6px 10px;
              border-radius: 4px;
              font-size: 12px;
              pointer-events: none;
              z-index: 10000;
              white-space: nowrap;
            `;
            document.body.appendChild(tooltip);
          }

          const jogador = MUNDO_DADOS.jogadoresMap.get(nearestVillage.idJogador);
          const tribo = jogador ? MUNDO_DADOS.tribosMap.get(jogador.idTribo) : null;

          let tooltipText = `${nearestVillage.x}|${nearestVillage.y}`;
          if (nearestVillage.nome) tooltipText += ` - ${nearestVillage.nome}`;
          if (jogador) {
            // Normalizar nome (remover "+" e normalizar espaços)
            const nomeNormalizado = jogador.nome.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
            tooltipText += `<br>Jogador: ${nomeNormalizado}`;
          }
          if (tribo) tooltipText += `<br>Tribo: [${tribo.tag}] ${tribo.nome}`;
          if (nearestVillage.pontos) tooltipText += `<br>Pontos: ${nearestVillage.pontos.toLocaleString()}`;

          tooltip.innerHTML = tooltipText;
          tooltip.style.left = (e.clientX + 10) + 'px';
          tooltip.style.top = (e.clientY + 10) + 'px';
          tooltip.style.display = 'block';
        } else {
          if (tooltip) tooltip.style.display = 'none';
        }
      }
    });

    // Mouse up (terminar drag)
    canvas.addEventListener('mouseup', (e) => {
      mapDragState.isDragging = false;
      mapDragState.dragStartX = undefined;
      mapDragState.dragStartY = undefined;
      canvas.style.cursor = 'grab';
    });

    canvas.addEventListener('mouseleave', () => {
      mapDragState.isDragging = false;
      mapDragState.dragStartX = undefined;
      mapDragState.dragStartY = undefined;
      canvas.style.cursor = 'grab';
      // Remover tooltip
      const tooltip = document.getElementById('map-tooltip');
      if (tooltip) tooltip.remove();
    });
  }

  async function renderTable(){
    if (!uiTbody) return;

    // Garantir que dados do mundo estão carregados antes de renderizar links
    if (!MUNDO_DADOS.loaded) {
      try {
        await loadWorldData();
      } catch (e) {
        dlog('Erro ao carregar dados do mundo para links:', e);
      }
    }

    uiTbody.innerHTML='';

    const now=Date.now();
    const ft=(filters.type?.value||'').toLowerCase();
    const fta=(filters.target?.value||'').toLowerCase();
    const fde=(filters.defender?.value||'').toLowerCase();
    const fori=(filters.origin?.value||'').toLowerCase();
    const fatk=(filters.attacker?.value||'').toLowerCase();
    const fmin=parseInt(filters.time?.value||'0',10);

    const rows=cache
      .filter(a => (a.arrival_at||0) > now)
      .filter(isVisibleAttack)
      .filter(a => cfg.supportsVisible || !isSupport(a))
      .filter(matchesAxeFilter)
      .filter(a=>!ft||(a.type||'').toLowerCase().includes(ft))
      .filter(a=>!fta||(a.target||'').toLowerCase().includes(fta))
      .filter(a=>!fde||(a.defender||'').toLowerCase().includes(fde))
      .filter(a=>!fori||(a.origin||'').toLowerCase().includes(fori))
      .filter(a=>!fatk||(a.attacker||'').toLowerCase().includes(fatk))
      .filter(a=>!fmin||((a.arrival_at-now)>0 && (a.arrival_at-now)<=fmin*60*1000))
      .sort((x, y) => {
          // ORDENAÇÃO BLINDADA - Garante que é número
          const tA = Number(x.arrival_at) || 0;
          const tB = Number(y.arrival_at) || 0;

          // Ordena por Tempo (Crescente - menor tempo primeiro)
          if (Math.abs(tA - tB) > 0) {
              return tA - tB;
          }

          // Desempate por ID (numérico)
          const idA = parseInt(x.command_id || 0, 10);
          const idB = parseInt(y.command_id || 0, 10);
          return idA - idB;
      });

    // DEBUG: Log dos primeiros 5 itens ordenados para conferência
    // if (rows.length > 0) {
    //     console.log("=== DEBUG ORDENAÇÃO ===");
    //     console.log("TOP 5 ORDENADOS:", rows.slice(0, 5).map(r => {
    //         const date = new Date(Number(r.arrival_at) || 0);
    //         const ms = String(date.getMilliseconds()).padStart(3, '0');
    //         return `${r.arrival_text || 'N/A'} (MS: ${ms}, Timestamp: ${r.arrival_at})`;
    //     }));
    // }

    updateStats(rows);

    const byPlayer = new Map();
    for (const a of rows){
      const p = (a.defender||'Jogador ?').trim();
      if (!byPlayer.has(p)) byPlayer.set(p, []);
      byPlayer.get(p).push(a);
    }

    const playersSorted = [...byPlayer.entries()]
      .sort((A,B)=>{
        const da = B[1].length - A[1].length;
        return da!==0 ? da : A[0].localeCompare(B[0],'pt-BR',{sensitivity:'base'});
      })
      .map(([name])=>name);

    for (const player of playersSorted){
      const list = byPlayer.get(player);
      const cnt = countersFor(list);

      // Contar ignorados deste player (de TODOS os ataques do cache, não apenas filtrados)
      const playerIgnored = cache.filter(a =>
        (a.arrival_at||0) > now &&
        (a.defender||'').trim() === player &&
        ignoredCombined.has(String(a.command_id))
      ).length;
      cnt.ignored = playerIgnored; // Sobrescrever com contagem correta

      const trP = document.createElement('tr');
      trP.className = 'tw-row-player';
      trP.setAttribute('data-role','player');
      trP.setAttribute('data-player', player);
      trP.innerHTML = `<td colspan="8"><span class="tw-toggle" data-action="toggle-player" data-player="${esc(player)}">[ ${OPEN_PLAYERS.has(player) ? '▼' : '+'} ]</span><span class="tw-label">Jogador:</span> ${esc(player)}<span style="margin-left:12px">${chipsHTML(cnt)}</span><span style="margin-left:12px;font-weight:700">Total: ${cnt.total}</span></td>`;
      uiTbody.appendChild(trP);

      const trPH = document.createElement('tr');
      trPH.setAttribute('data-role','player-holder');
      trPH.setAttribute('data-player', player);
      trPH.style.display = OPEN_PLAYERS.has(player) ? '' : 'none';
      trPH.innerHTML = `<td colspan="8" data-player-body></td>`;
      uiTbody.appendChild(trPH);

      if (OPEN_PLAYERS.has(player)) {
        renderVillagesForPlayer(player, trPH, true).catch(e => dlog('Erro ao renderizar aldeias:', e));
      }
    }
  }

  function setupTogglesDelegation(){
    if (!uiTbody) return;
    uiTbody.addEventListener('click', (ev)=>{
      const tgt = ev.target;
      if (!(tgt instanceof HTMLElement)) return;
      if (tgt.matches('[data-action="toggle-player"]')){
        const player = tgt.getAttribute('data-player') || '';
        const holder = uiTbody.querySelector(`tr[data-role="player-holder"][data-player="${CSS.escape(player)}"]`);
        const opened = holder && holder.style.display !== 'none';
        if (!opened){
          renderVillagesForPlayer(player, holder, true).catch(e => dlog('Erro:', e));
          holder.style.display = '';
          tgt.textContent = '[ ▼ ]';
          OPEN_PLAYERS.add(player);
          persistOpenSets();
        } else {
          holder.style.display = 'none';
          holder.innerHTML = `<td colspan="8" data-player-body></td>`;
          tgt.textContent = '[ + ]';
          for (const key of [...OPEN_VILLAGES]) if (key.startsWith(player+'||')) OPEN_VILLAGES.delete(key);
          OPEN_PLAYERS.delete(player);
          persistOpenSets();
        }
      }
      if (tgt.matches('[data-action="toggle-village"]')){
        const key = tgt.getAttribute('data-key') || '';
        const holder = uiTbody.querySelector(`tr[data-role="village-holder"][data-key="${CSS.escape(key)}"]`);
        const opened = holder && holder.style.display !== 'none';
        if (!opened){
          renderCommandsForVillage(key, holder);
          holder.style.display = '';
          tgt.textContent = '[ ▼ ]';
          OPEN_VILLAGES.add(key);
          persistOpenSets();
        } else {
          holder.style.display = 'none';
          holder.innerHTML = `<td colspan="8" data-village-body></td>`;
          tgt.textContent = '[ + ]';
          OPEN_VILLAGES.delete(key);
          persistOpenSets();
        }
      }
    });
  }

  async function renderVillagesForPlayer(player, playerHolderTr, restoreVillages=false){
    if (!playerHolderTr) return;

    // Garantir que dados do mundo estão carregados antes de renderizar links
    if (!MUNDO_DADOS.loaded) {
      dlog('[Links] Tentando carregar dados do mundo antes de renderizar aldeias...');
      try {
        await loadWorldData();
      } catch (e) {
        dlog('[Links] Erro ao carregar dados do mundo:', e);
      }
    }
    const cell = playerHolderTr.querySelector('[data-player-body]');
    if (!cell) return;
    cell.innerHTML = '';
    const now=Date.now();
    const ft=(filters.type?.value||'').toLowerCase();
    const fta=(filters.target?.value||'').toLowerCase();
    const fde=(filters.defender?.value||'').toLowerCase();
    const fori=(filters.origin?.value||'').toLowerCase();
    const fatk=(filters.attacker?.value||'').toLowerCase();
    const fmin=parseInt(filters.time?.value||'0',10);
    const rows=cache
      .filter(a => (a.arrival_at||0) > now)
      .filter(isVisibleAttack)
      .filter(a => cfg.supportsVisible || !isSupport(a))
      .filter(matchesAxeFilter)
      .filter(a=>!ft||(a.type||'').toLowerCase().includes(ft))
      .filter(a=>!fta||(a.target||'').toLowerCase().includes(fta))
      .filter(a=>!fde||(a.defender||'').toLowerCase().includes(fde))
      .filter(a=>!fori||(a.origin||'').toLowerCase().includes(fori))
      .filter(a=>!fatk||(a.attacker||'').toLowerCase().includes(fatk))
      .filter(a=>(a.defender||'').trim()===player)
      .filter(a=>!fmin||((a.arrival_at-now)>0 && (a.arrival_at-now)<=fmin*60*1000))
      .sort((x, y) => {
          // Força conversão para número inteiro (timestamp) - ORDENAÇÃO MATEMÁTICA
          let timeA = parseInt(x.arrival_at || 0, 10);
          let timeB = parseInt(y.arrival_at || 0, 10);

          // SE der NaN ou 0 (porque é texto "hoje às..."), usa a função para converter
          if (isNaN(timeA) || timeA === 0) {
            const parsed = parseArrivalAbsolute(x.arrival_at) || 0;
            timeA = parseInt(parsed, 10) || 0;
          }
          if (isNaN(timeB) || timeB === 0) {
            const parsed = parseArrivalAbsolute(y.arrival_at) || 0;
            timeB = parseInt(parsed, 10) || 0;
          }

          // 1. Critério Principal: Tempo de Chegada (Crescente - menor tempo primeiro)
          if (timeA !== timeB) {
              return timeA - timeB;
          }

          // 2. Critério de Desempate: ID do Comando (numérico)
          // Isso evita que ataques no mesmo milissegundo fiquem "dançando" na tabela
          const idA = parseInt(x.command_id || 0, 10);
          const idB = parseInt(y.command_id || 0, 10);
          return idA - idB;
      });

    const byVillage = new Map();
    for (const a of rows){
      const v = (a.target||'Aldeia ?').trim();
      if (!byVillage.has(v)) byVillage.set(v, []);
      byVillage.get(v).push(a);
    }
    const villagesSorted = [...byVillage.entries()]
      .sort((A,B)=>{
        const da = B[1].length - A[1].length;
        return da!==0 ? da : A[0].localeCompare(B[0],'pt-BR',{sensitivity:'base'});
      })
      .map(([name])=>name);

    const frag = document.createDocumentFragment();
    for (const village of villagesSorted){
      const list = byVillage.get(village);
      const cnt  = countersFor(list);

      // Contar ignorados desta aldeia (de TODOS os ataques do cache, não apenas filtrados)
      const villageIgnored = cache.filter(a =>
        (a.arrival_at||0) > now &&
        (a.defender||'').trim() === player &&
        (a.target||'').trim() === village &&
        ignoredCombined.has(String(a.command_id))
      ).length;
      cnt.ignored = villageIgnored; // Sobrescrever com contagem correta

      const key  = player + '||' + village;
      const trV = document.createElement('tr');
      trV.className = 'tw-row-village';
      trV.setAttribute('data-role','village');
      trV.setAttribute('data-key', key);
      // Buscar ID da aldeia pelas coordenadas para criar link
      const villageCoords = extractCoordsFromVillageName(village);
      const villageId = villageCoords ? findVillageIdByCoords(villageCoords.x, villageCoords.y) : null;
      const villageLink = villageId ? buildVillageLink(villageId, villageCoords) : null;
      const villageDisplay = villageLink
        ? `<a href="${esc(villageLink)}" target="_blank" style="color:#007bff;text-decoration:underline;font-weight:bold">${esc(village)}</a>`
        : esc(village);

      trV.innerHTML = `<td colspan="8"><span class="tw-toggle" data-action="toggle-village" data-key="${esc(key)}">[ ${OPEN_VILLAGES.has(key) ? '▼' : '+'} ]</span><span class="tw-label">Aldeia:</span> ${villageDisplay}<span style="margin-left:12px">${chipsHTML(cnt)}</span><span style="margin-left:12px;font-weight:700">Total: ${cnt.total}</span></td>`;
      frag.appendChild(trV);
      const trVH = document.createElement('tr');
      trVH.setAttribute('data-role','village-holder');
      trVH.setAttribute('data-key', key);
      trVH.style.display = OPEN_VILLAGES.has(key) ? '' : 'none';
      trVH.innerHTML = `<td colspan="8" data-village-body></td>`;
      frag.appendChild(trVH);
    }
    cell.appendChild(frag);

    if (restoreVillages){
      OPEN_VILLAGES.forEach(key=>{
        if (!key.startsWith(player+'||')) return;
        const btn = uiTbody.querySelector(`[data-action="toggle-village"][data-key="${CSS.escape(key)}"]`);
        const holder = uiTbody.querySelector(`tr[data-role="village-holder"][data-key="${CSS.escape(key)}"]`);
        if (btn && holder && holder.style.display==='none'){
          renderCommandsForVillage(key, holder);
          holder.style.display = '';
          btn.textContent = '[ ▼ ]';
        } else if (btn && holder && holder.style.display!=='none' && !holder.querySelector('[data-village-body] > *')) {
          renderCommandsForVillage(key, holder);
        }
      });
    }
  }

  function renderCommandsForVillage(key, villageHolderTr){
    if (!villageHolderTr) return;
    const cell = villageHolderTr.querySelector('[data-village-body]');
    if (!cell) return;
    cell.innerHTML = '';
    const [player, village] = key.split('||');
    const now=Date.now();
    const ft=(filters.type?.value||'').toLowerCase();
    const fta=(filters.target?.value||'').toLowerCase();
    const fde=(filters.defender?.value||'').toLowerCase();
    const fori=(filters.origin?.value||'').toLowerCase();
    const fatk=(filters.attacker?.value||'').toLowerCase();
    const fmin=parseInt(filters.time?.value||'0',10);
    const rows=cache
      .filter(a => (a.arrival_at||0) > now)
      .filter(isVisibleAttack)
      .filter(a => cfg.supportsVisible || !isSupport(a))
      .filter(matchesAxeFilter)
      .filter(a=>!ft||(a.type||'').toLowerCase().includes(ft))
      .filter(a=>!fta||(a.target||'').toLowerCase().includes(fta))
      .filter(a=>!fde||(a.defender||'').toLowerCase().includes(fde))
      .filter(a=>!fori||(a.origin||'').toLowerCase().includes(fori))
      .filter(a=>!fatk||(a.attacker||'').toLowerCase().includes(fatk))
      .filter(a=>(a.defender||'').trim()===player && (a.target||'').trim()===village)
      .filter(a=>!fmin||((a.arrival_at-now)>0 && (a.arrival_at-now)<=fmin*60*1000))
      .sort((x, y) => {
          // Força conversão para número inteiro (timestamp) - ORDENAÇÃO MATEMÁTICA
          let timeA = parseInt(x.arrival_at || 0, 10);
          let timeB = parseInt(y.arrival_at || 0, 10);

          // SE der NaN ou 0 (porque é texto "hoje às..."), usa a função para converter
          if (isNaN(timeA) || timeA === 0) {
            const parsed = parseArrivalAbsolute(x.arrival_at) || 0;
            timeA = parseInt(parsed, 10) || 0;
          }
          if (isNaN(timeB) || timeB === 0) {
            const parsed = parseArrivalAbsolute(y.arrival_at) || 0;
            timeB = parseInt(parsed, 10) || 0;
          }

          // 1. Critério Principal: Tempo de Chegada (Crescente - menor tempo primeiro)
          if (timeA !== timeB) {
              return timeA - timeB;
          }

          // 2. Critério de Desempate: ID do Comando (numérico)
          // Isso evita que ataques no mesmo milissegundo fiquem "dançando" na tabela
          const idA = parseInt(x.command_id || 0, 10);
          const idB = parseInt(y.command_id || 0, 10);
          return idA - idB;
      });

    const sub = document.createElement('table');
    sub.className = 'tw-subtable';
    sub.innerHTML = `${colgroupHTML()}<thead><tr><th></th><th>Comando</th><th>Destino</th><th>Defensor</th><th>Origem</th><th>Atacante</th><th>Chegada</th><th>Chega em</th></tr></thead><tbody></tbody>`;
    const tbody = sub.querySelector('tbody');
    const frag = document.createDocumentFragment();
    for (const a of rows){
      const tr=document.createElement('tr');
      const isIgnored = ignoredCombined.has(String(a.command_id));
      if (isIgnored) {
        tr.classList.add('tw-row-ignored');
        if (!cfg.showIgnored) tr.style.display = 'none';
      }
      const tdIcon=document.createElement('td');
      const axeSrc=a.icon_src||DEFAULT_AXE_ICON;
      const isProv = getAxeType(a)==='small_medium';
      tdIcon.innerHTML = isProv
        ? `<div class="tw-axe-ctr" title="Small/Medium (provisório)"><span class="stack" style="display:inline-flex;gap:2px;align-items:center"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'small'))}"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'medium'))}"></span></div>`
        : `<div class="tw-axe-ctr" title="${esc(a.icon_key||'attack')}"><img src="${esc(axeSrc)}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_AXE_ICON}';"/>${a.watchtower ? '<span class="num" title="Watchtower">👁</span>' : ''}</div>`;
      tr.appendChild(tdIcon);
      const tdType=document.createElement('td');
      const typeText = a.type || '';
      // Adicionar ícone de nobre antes de "Nobre" quando for um nobre recebido
      if (isNoble(a)) {
        tdType.innerHTML = `<img src="${esc(NOBLE_ICON)}" alt="Nobre" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px; display: inline-block;">${esc(typeText)}`;
      } else {
        tdType.textContent = typeText;
      }
      if (cfg.colorizeEnabled) {
        let style='';
        if (isSupport(a)) style='background:yellow;color:black;font-weight:bold;';
        else {
          const c=getCommandColor(a.type);
          if (c) style=`background:${c.background};color:${c.color};font-weight:bold;`;
        }
        tdType.style=style;
        tdType.classList.add('command-colored');
      }
      tr.appendChild(tdType);
      [a.target, a.defender, a.origin, a.attacker].forEach(val=>{
        const td=document.createElement('td'); td.textContent=val||''; tr.appendChild(td);
      });
      const tdArr=document.createElement('td');
      tdArr.textContent=(a.arrival_text||'').replace(/\(atual\)/i,'').trim();
      tr.appendChild(tdArr);
      const tdEta=document.createElement('td');
      const pill=document.createElement('span');
      pill.className='tw-blue-elves-pill tw-countdown';
      pill.dataset.arrival = String(Math.floor((a.arrival_at||0)/1000));
      tdEta.appendChild(pill);
      tr.appendChild(tdEta);
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    cell.appendChild(sub);
  }

  function tickCountdowns(){
    const nowSec = Math.floor(Date.now()/1000);
    document.querySelectorAll('.tw-countdown').forEach(el=>{
      const arrival = parseInt(el.dataset.arrival||'0',10);
      const left = arrival - nowSec;
      const h = Math.max(0, Math.floor(left/3600));
      const m = Math.max(0, Math.floor((left%3600)/60));
      const s = Math.max(0, left%60);
      el.textContent = left<=0 ? 'CHEGOU' : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (left<=0){ el.style.background='#b71c1c'; el.style.color='#fff'; }
      else if (left<=15*60){ el.style.background='#ff9800'; el.style.color='#fff'; }
      else if (left<=60*60){ el.style.background='#ffeb3b'; el.style.color='#000'; }
      else { el.style.background='#333'; el.style.color='#fff'; }
    });
  }

  function readCache(){
    try{ const s = GM_getValue(CACHE_KEY, '[]'); const arr = JSON.parse(s); const when = Number(GM_getValue(CACHE_AT, 0)) || 0; return {attacks:Array.isArray(arr)?arr:[], at:when}; }
    catch{ return {attacks:[], at:0}; }
  }
  function writeCache(attacks){
    try{ GM_setValue(CACHE_KEY, JSON.stringify(attacks||[])); GM_setValue(CACHE_AT, Date.now()); }catch{}
  }
  function fmtAgo(ms){
    const m = Math.max(0, Math.floor(ms/60000));
    if (m<60) return `${m} min`;
    const h = Math.floor(m/60), rm=m%60;
    return rm?`${h} h ${rm} min`:`${h} h`;
  }

  const NETQ_BASE_INTERVAL_MS = 15000;   // 15 segundos (quando página aberta)
  const NETQ_JITTER_MS = 0;              // Sem jitter quando página aberta
  const NETQ_BACKGROUND_BASE_INTERVAL_MS = 90000;  // 90 segundos (background)
  const NETQ_BACKGROUND_JITTER_MS = 30000;         // ±30 segundos (humanizar)
  const NETQ_MAX_BATCH   = 1000; // Aumentado para suportar múltiplas páginas (servidor aceita até 5MB)
  let __netQueue = new Map();
  let __netTimer = null;
  function attackFingerprint(a) {
    return [a.command_id, a.origin, a.target, a.attacker, a.defender, a.arrival_at, a.axe_size, a.icon_key, a.watchtower ? 1 : 0].join('|');
  }
  const __lastSentHash = new Map();
  function netQueueAdd(attacks) {
    if (!attacks || attacks.length === 0) return;
    if (isCaptchaPage()) return;

    // Adicionar ataques à fila de rede
    let addedCount = 0;
    const cache = getPersistentCache(PERSISTENT_ATTACKS_CACHE_KEY);

    attacks.forEach(attack => {
      if (attack && attack.command_id) {
        const id = String(attack.command_id);
        const fp = attackFingerprint(attack);

        // Ignorar ataques já enviados com o mesmo fingerprint
        if (cache[id] && cache[id].hash === fp) {
          return;
        }

        if (!__netQueue.has(id)) {
          __netQueue.set(id, attack);
          addedCount++;
        }
      }
    });

    if (addedCount > 0) {
      dlog(`📋 ${addedCount} ataques adicionados à fila (${__netQueue.size} total)`);
      updateStatusIndicator('twInlineBtn', 'pending');
    }

    // Agendar envio
    if (__netQueue.size > 0) {
        scheduleNetFlush();
    }
  }
  function __beHumanInterval(baseMs, jitterMs){
    const j = Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs; // [-jitter, +jitter]
    return Math.max(30_000, baseMs + j); // nunca menos que 30s (segurança)
  }

  function scheduleNetFlush() {
    // Prevenir múltiplos timers simultâneos
    if (__netTimer) return;

    __netTimer = setTimeout(async () => {
      __netTimer = null;
      if (__netQueue.size === 0) return;
      if (isCaptchaPage()) return;
      const batch = [];
      for (const [id, a] of __netQueue) {
        batch.push(a);
        if (batch.length >= NETQ_MAX_BATCH) break;
      }
      for (const a of batch) __netQueue.delete(String(a.command_id));
      try {
        dlog(`📤 Enviando ${batch.length} ataques para o servidor`);
        await uploadAttacks(batch);
        
        // Gravar no cache persistente após sucesso
        const cache = getPersistentCache(PERSISTENT_ATTACKS_CACHE_KEY);
        for (const a of batch) {
          const id = String(a.command_id);
          cache[id] = {
            hash: attackFingerprint(a),
            arrival_at: Number(a.arrival_at) || 0
          };
          __lastSentHash.set(id, attackFingerprint(a));
        }
        savePersistentCache(PERSISTENT_ATTACKS_CACHE_KEY, cache);
        updateStatusIndicator('twInlineBtn', 'success');
      } catch(e) {
        dlog(`❌ Erro ao enviar ataques: ${e.message}`);
        updateStatusIndicator('twInlineBtn', 'error');
        for (const a of batch) __netQueue.set(String(a.command_id), a);
      }
      if (__netQueue.size > 0) scheduleNetFlush();
    }, 2000); // Envio rápido (2s) para agrupar páginas sem atraso desnecessário
  }
  async function uploadAttacks(attacks, retryCount = 0) {
    // Páginas especiais podem enviar mesmo se bloqueadas por outras abas normais
    if (__beBlocked && !__isSpecialPage) return;

    // Se é página especial e está enviando, notificar outras abas
    if (__isSpecialPage && !__isSendingActive) {
      notifySpecialPageActive();
    }
    // Verificar se servidor está configurado
    if (!cfg.serverURL || !cfg.authToken) {
      dlog('Servidor não configurado - pulando upload de ataques');
      return;
    }

    try{
      ensureConfig();
      const now=Date.now();

      // CRÍTICO: Obter nome correto da página de aldeia ANTES de enviar
      // Isso garante que mesmo se o cache tiver nome antigo (ex: modo de férias), usamos o correto
      let correctDefenderName = null;
      if (isVillageInfoPage()) {
        const villageName = getPlayerNameFromVillagePage();
        if (villageName) {
          correctDefenderName = normalizeName(villageName);
          // Atualizar cache global e cache por aldeia
          if (__cachedPlayerName !== correctDefenderName) {
            __cachedPlayerName = correctDefenderName;
            if (cfg.debug) dlog(`[uploadAttacks] ⚠️ Cache global atualizado antes de enviar: "${__cachedPlayerName}" → "${correctDefenderName}"`);
          }
          // Cache por aldeia já foi atualizado dentro de getPlayerNameFromVillagePage()
        } else {
          // Tentar usar cache por aldeia se disponível
          const villageCoords = getVillageCoordsFromURL();
          const villageKey = villageCoords ? `${villageCoords.x}|${villageCoords.y}` : null;
          if (villageKey && __villagePlayerNameCache && __villagePlayerNameCache.has(villageKey)) {
            correctDefenderName = normalizeName(__villagePlayerNameCache.get(villageKey));
            if (cfg.debug) dlog(`[uploadAttacks] ✅ Usando cache da aldeia ${villageKey}: "${correctDefenderName}"`);
          }
        }
      }

      const payload=(attacks||[]).map(a=>{
        // CRÍTICO: Se temos nome correto da aldeia, SEMPRE usar ele
        let defender = correctDefenderName || String(a.defender||'');
        if (defender) {
          defender = normalizeName(defender);
        }

        // Se ainda não temos defender e estamos na página de aldeia, tentar novamente
        if (!defender && isVillageInfoPage()) {
          defender = normalizeName(getPlayerNameFromVillagePage() || getLoggedPlayerName() || '');
        }

        return {
          command_id:String(a.command_id||''), world:cfg.world,
          type:String(a.type||''), target:String(a.target||''), defender:defender, origin:String(a.origin||''), attacker:String(a.attacker||''),
          distance:String(a.distance||''), arrival_text:String(a.arrival_text||''), arrival_at:Number(a.arrival_at)||0,
          captured_at:Number(a.captured_at)||now, source:String(a.source||'local'),
          icon_key:String(a.icon_key||''), icon_src:String(a.icon_src||''), icon_alt:String(a.icon_alt||''),
          axe_size:String(a.axe_size||'unknown'), watchtower:Boolean(a.watchtower)
        };
      }).filter(a=>a.command_id && a.world);
      if (!payload.length){ return; }

      const url=cfg.serverURL.replace(/\/$/,'')+'/api/attacks';
      const resp=await rateLimitFetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Auth-Token': cfg.authToken },
        body:JSON.stringify({
          world: cfg.world,
          attacks: payload,
          player: getLoggedPlayerName(),
          sessionId: SESSION_ID,
          version: VERSION_TEXT,
          isSpecialPage: __isSpecialPage // Flag para páginas especiais (incomings/commands)
        })
      });
      if (resp.status === 429) {
        // Páginas especiais podem tentar mesmo com 429 (servidor deve permitir mais sessões)
        if (__isSpecialPage) {
          dlog('⚠️ [Upload] Status 429 recebido, mas página especial continua tentando');
          // Não bloqueia - deixa o servidor decidir
        } else {
          // Se ainda não está bloqueada pelo heartbeat, tentar heartbeat primeiro
          // (pode ser que o heartbeat ainda não tenha sido executado)
          if (!__beBlocked) {
            dlog('⚠️ [Upload] Status 429 recebido, tentando heartbeat para confirmar bloqueio...');
            try {
              await sendHeartbeat();
              // Se após heartbeat ainda não está bloqueada, então realmente é outra aba
              if (!__beBlocked && !__beSessionActive) {
                await __beLogBlockedOnce('outra aba');
                __beStopSendingOnly();
              }
            } catch (e) {
              // Se heartbeat falhar, bloquear
              await __beLogBlockedOnce('outra aba');
              __beStopSendingOnly();
            }
          } else {
            // Já estava bloqueada, apenas confirmar
            await __beLogBlockedOnce('outra aba');
            __beStopSendingOnly();
          }
          return;
        }
      }
      const json=await resp.json().catch(()=>({}));
      if (!resp.ok) throw new Error('HTTP '+resp.status);
      __beMarkActiveAndLogIfNeeded();
      setStatus(`✅ Enviado (lote): ${Number(json.count||0)}/${payload.length}`);
    }catch(e){
      // Retry logic para deadlocks e timeouts
      if (retryCount < 3 && (e.message.includes('deadlock') || e.message.includes('timeout') || e.message.includes('57014') || e.message.includes('40P01'))) {
        const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff: 1s, 2s, 4s
        dlog(`Tentativa ${retryCount + 1}/3 falhou, tentando novamente em ${delay}ms:`, e.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        return uploadAttacks(attacks, retryCount + 1);
      }

      setStatus('❌ Falha upload', true);
      throw e;
    }
  }

  // ===== FILA E UPLOAD DE COMANDOS ENVIADOS =====
  const COMMANDS_NETQ_BASE_INTERVAL_MS = 15000;   // 15 segundos (quando página aberta)
  const COMMANDS_NETQ_JITTER_MS = 0;              // Sem jitter quando página aberta
  const COMMANDS_NETQ_BACKGROUND_BASE_INTERVAL_MS = 420000;  // 7 minutos (background)
  const COMMANDS_NETQ_BACKGROUND_JITTER_MS = 60000;         // ±60 segundos (humanizar)
  const COMMANDS_NETQ_MAX_BATCH = 1000; // Aumentado para suportar múltiplas páginas (servidor aceita até 5MB)
  let __commandsQueue = new Map();
  let __commandsTimer = null;

  function commandsQueueAdd(commands) {
    if (!commands || commands.length === 0) {
      dlog('⚠️ [Commands] commandsQueueAdd chamado com array vazio ou null');
      return;
    }
    if (isCaptchaPage()) return;
    dlog(`📥 [Commands] Adicionando ${commands.length} comandos à fila...`);
    let addedCount = 0;
    let skippedCount = 0;
    const cache = getPersistentCache(PERSISTENT_COMMANDS_CACHE_KEY);

    commands.forEach(cmd => {
      if (cmd && cmd.command_id) {
        const id = String(cmd.command_id);
        const fp = attackFingerprint(cmd);

        // Ignorar comandos já enviados com o mesmo fingerprint
        if (cache[id] && cache[id].hash === fp) {
          skippedCount++;
          return;
        }

        if (!__commandsQueue.has(id)) {
          __commandsQueue.set(id, cmd);
          addedCount++;
        } else {
          skippedCount++;
        }
      } else {
        dlog(`⚠️ [Commands] Comando inválido (sem command_id):`, cmd);
      }
    });
    if (addedCount > 0) {
      dlog(`✅ [Commands] ${addedCount} comandos enviados adicionados à fila (${__commandsQueue.size} total, ${skippedCount} duplicados ignorados)`);
      updateStatusIndicator('be-commands-send-btn', 'pending');
    } else {
      dlog(`⚠️ [Commands] Nenhum comando novo adicionado (${skippedCount} duplicados, ${__commandsQueue.size} na fila)`);
    }
    if (__commandsQueue.size > 0) {
      dlog(`🔄 [Commands] Agendando envio de comandos...`);
      scheduleCommandsFlush();
    }
  }

  function scheduleCommandsFlush() {
    if (__commandsTimer) return;

    __commandsTimer = setTimeout(async () => {
      __commandsTimer = null;
      if (__commandsQueue.size === 0) return;
      if (isCaptchaPage()) return;
      const batch = [];
      for (const [id, c] of __commandsQueue) {
        batch.push(c);
        if (batch.length >= COMMANDS_NETQ_MAX_BATCH) break;
      }
      for (const c of batch) __commandsQueue.delete(String(c.command_id));
      try {
        dlog(`📤 [Commands] Enviando ${batch.length} comandos enviados para o servidor (fila restante: ${__commandsQueue.size})`);
        await uploadCommands(batch);
        dlog(`✅ [Commands] Lote de ${batch.length} comandos enviado com sucesso`);

        // Gravar no cache persistente após sucesso
        const cache = getPersistentCache(PERSISTENT_COMMANDS_CACHE_KEY);
        for (const c of batch) {
          const id = String(c.command_id);
          cache[id] = {
            hash: attackFingerprint(c),
            arrival_at: Number(c.arrival_at) || 0
          };
        }
        savePersistentCache(PERSISTENT_COMMANDS_CACHE_KEY, cache);
        updateStatusIndicator('be-commands-send-btn', 'success');
      } catch(e) {
        dlog(`❌ [Commands] Erro ao enviar comandos enviados: ${e.message}`);
        dlog(`❌ [Commands] Stack:`, e.stack);
        updateStatusIndicator('be-commands-send-btn', 'error');
        // Recolocar comandos na fila em caso de erro
        for (const c of batch) __commandsQueue.set(String(c.command_id), c);
      }
      if (__commandsQueue.size > 0) scheduleCommandsFlush();
    }, 2000); // Envio rápido (2s) para agrupar páginas sem atraso desnecessário
  }

  async function uploadCommands(commands, retryCount = 0) {
    // Páginas especiais podem enviar mesmo se bloqueadas por outras abas normais
    if (__beBlocked && !__isSpecialPage) return;

    // Se é página especial e está enviando, notificar outras abas
    if (__isSpecialPage && !__isSendingActive) {
      notifySpecialPageActive();
    }
    if (!cfg.commandsServerURL || !cfg.commandsAuthToken) return;
    if (!commands || commands.length === 0) {
      return;
    }
    try {
      const now = Date.now();
      const payload = commands.map(cmd => ({
        command_id: String(cmd.command_id || ''),
        type: String(cmd.type || ''),
        target: String(cmd.target || ''),
        origin: String(cmd.origin || ''),
        attacker: String(cmd.attacker || ''),
        distance: String(cmd.distance || ''),
        arrival_text: String(cmd.arrival_text || ''),
        arrival_at: Number(cmd.arrival_at) || 0,
        sent_at: Number(cmd.captured_at) || now,
        source: String(cmd.source || 'local'),
        icon_key: String(cmd.icon_key || ''),
        icon_src: String(cmd.icon_src || ''),
        icon_alt: String(cmd.icon_alt || ''),
        axe_size: String(cmd.axe_size || 'unknown'),
        watchtower: Boolean(cmd.watchtower)
      })).filter(c => c.command_id && c.target && c.origin);
      if (payload.length === 0) return;
      const url = cfg.commandsServerURL.replace(/\/$/, '') + '/api/commands/sent';
      const resp = await rateLimitFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': cfg.commandsAuthToken },
        body: JSON.stringify({
          world: cfg.world,
          commands: payload,
          player: getLoggedPlayerName(),
          sessionId: SESSION_ID,
          version: VERSION_TEXT,
          isSpecialPage: __isSpecialPage // Flag para páginas especiais (incomings/commands)
        })
      });
      if (resp.status === 429) {
        // Páginas especiais podem tentar mesmo com 429 (servidor deve permitir mais sessões)
        if (__isSpecialPage) {
          dlog('⚠️ [Upload] Status 429 recebido, mas página especial continua tentando');
          // Não bloqueia - deixa o servidor decidir
        } else {
          await __beLogBlockedOnce('outra aba');
          __beStopSendingOnly();
          return;
        }
      }
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      __beMarkActiveAndLogIfNeeded();
    } catch(e) {
      if (retryCount < 3 && (String(e.message).includes('500') || String(e.message).includes('timeout'))) {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return uploadCommands(commands, retryCount + 1);
      }
      throw e;
    }
  }

  async function fetchAndRender(){
    // VERSÃO MINIMAL: Apenas envia dados, não busca do servidor
    try{
      ensureConfig();
      const localAttacks = collectAttacksFromDOM();

      // Gatilho único: envio/coleta acontece no background sync (aqui não faz envio)

      // VERSÃO MINIMAL: Não busca dados do servidor
      const serverAttacks = [];
      /* CÓDIGO DESABILITADO - VERSÃO MINIMAL
      // Buscar dados do servidor SEMPRE (nunca pausar)
      let serverAttacks = [];
      if (cfg.serverURL && cfg.authToken) {
        try {
          serverAttacks = await fetchAttacksFromServer();
          dlog(`📥 Recebendo ${serverAttacks.length} ataques do servidor (sempre ativo)`);
      } catch (e) {
          dlog('Erro ao buscar ataques do servidor:', e);
        }
      } else {
        dlog('📥 Servidor não configurado');
      }

      // VERSÃO MINIMAL: Não verifica Discord, não atualiza cache, não renderiza
      // Apenas envia dados locais para o servidor
      return; // Função simplificada - apenas envia, não processa dados recebidos

      /* CÓDIGO DESABILITADO - VERSÃO MINIMAL
      // Verificar nobres para Discord (só quando UI aberta)
      if (!isPaused()) {
        cleanupDiscordNotifications();
        checkDiscordNobles([...localAttacks, ...serverAttacks]);
      }

      // Combinar ataques locais e do servidor (lógica simples e segura)
      const uniqueAttacks = new Map();

      // Primeiro: adicionar TODOS os ataques do servidor (base)
      serverAttacks.forEach(attack => {
        if (attack.command_id) {
          uniqueAttacks.set(attack.command_id, attack);
        }
      });

      // Segundo: sobrescrever com ataques locais (prioridade local)
      localAttacks.forEach(attack => {
        if (attack.command_id) {
          uniqueAttacks.set(attack.command_id, attack);
        }
      });

      cache = Array.from(uniqueAttacks.values())
        .filter(a => (a.arrival_at||0) > Date.now()); // Apenas ataques futuros

      // Debug: mostrar contagem de ataques
      const localCount = localAttacks.length;
      const serverCount = serverAttacks.length;
      const finalCount = cache.length;
      dlog(`🔗 Combinação: ${localCount} locais + ${serverCount} servidor = ${finalCount} total`);

      if (cfg.provisionalEnabled) {
        cache = applyProvisionalByOrigin(cache);
      }

      await refreshIgnoredCombined();

      if (isPaused()) {
        setStatus(`📤 Enviando dados (UI fechada): ${localAttacks.length} ataques locais`);
      } else {
        setStatus(`🔗 Servidor: ${cache.length} ataques (${localAttacks.length} locais + ${serverAttacks.length} servidor)`);
      }

      if (uiInitialized) renderTable();

      // Atualizar badge de nobres após atualizar cache
      updateNobleBadge();

      dlog(`Total: ${cache.length} ataques futuros (${localAttacks.length} locais + ${serverAttacks.length} servidor)`);
      */
    }catch(e){
      // VERSÃO MINIMAL: Apenas loga erro, não processa dados
      dlog('fetchAndRender erro:', e);
      /* CÓDIGO DESABILITADO - VERSÃO MINIMAL
      const localAttacks=collectAttacksFromDOM();
      cache=localAttacks.filter(a => (a.arrival_at||0) > Date.now());
      setStatus(`⚠️ Erro na coleta. Exibindo ${cache.length} ataques locais.`, true);
      await refreshIgnoredCombined();
      if (uiInitialized) renderTable();
      */
    }
  }

  // ===== FUNCIONALIDADE: VISUALIZAÇÃO DE ATAQUES EM ALDEIA =====

  // Função para extrair coordenadas da URL
  // Função desabilitada na versão minimal - script Players não deve obter coordenadas
  function getVillageCoordsFromURL() {
    // VERSÃO MINIMAL: Sempre retorna null - não obter coordenadas de aldeias
    return null;
    /* Código original desabilitado:
    try {
      // Tentar pegar do hash: #547;526
      const hash = location.hash;
      if (hash) {
        const match = hash.match(/#(\d+);(\d+)/);
        if (match) {
          return { x: parseInt(match[1]), y: parseInt(match[2]) };
        }
      }

      // Tentar pegar da página (nome da aldeia pode ter coordenadas)
      const villageNameEl = document.querySelector('.village_anchor, .quickedit-label');
      if (villageNameEl) {
        const text = villageNameEl.textContent || '';
        const match = text.match(/(\d+)\|(\d+)/);
        if (match) {
          return { x: parseInt(match[1]), y: parseInt(match[2]) };
        }
      }

      // Tentar pegar do título ou conteúdo da página
      const titleMatch = document.title.match(/(\d+)\|(\d+)/);
      if (titleMatch) {
        return { x: parseInt(titleMatch[1]), y: parseInt(titleMatch[2]) };
      }

      return null;
    } catch (e) {
      dlog('Erro ao extrair coordenadas:', e);
      return null;
    }
    */
  }

  // Função para normalizar coordenadas do ataque
  function normalizeTargetCoords(target) {
    if (!target) return null;
    // Formato: "555|555" ou "Aldeia 555|555"
    const match = String(target).match(/(\d+)\|(\d+)/);
    if (match) {
      return { x: parseInt(match[1]), y: parseInt(match[2]) };
    }
    return null;
  }

  // Função para extrair coordenadas de origem
  function normalizeOriginCoords(origin) {
    if (!origin) return null;
    // Formato: "555|555" ou "Aldeia 555|555"
    const match = String(origin).match(/(\d+)\|(\d+)/);
    if (match) {
      return { x: parseInt(match[1]), y: parseInt(match[2]) };
    }
    return null;
  }

  // Verificar se é página de info de aldeia
  function isVillageInfoPage() {
    const params = new URLSearchParams(location.search);
    return params.get('screen') === 'info_village';
  }

  // Cache por aldeia (coordenadas) para evitar confusão com modo de férias
  let __villagePlayerNameCache = new Map(); // Map<"x|y", playerName>

  // Função para obter o nome do jogador da página de aldeia (mais confiável que getLoggedPlayerName)
  // CRÍTICO: Esta função SEMPRE prevalece sobre getLoggedPlayerName() quando estamos na página de aldeia
  // Isso resolve o problema de modo de férias onde contas ficam "juntas"
  function getPlayerNameFromVillagePage() {
    try {
      // Obter coordenadas da aldeia atual para cache específico
      // Nota: getVillageCoordsFromURL() retorna null na versão minimal, mas mantemos a lógica
      const villageCoords = getVillageCoordsFromURL();
      const villageKey = villageCoords ? `${villageCoords.x}|${villageCoords.y}` : null;

      // Se temos cache para esta aldeia específica, usar (mas verificar se ainda é válido)
      if (villageKey && __villagePlayerNameCache.has(villageKey)) {
        const cachedName = __villagePlayerNameCache.get(villageKey);
        // Verificar se o nome ainda está na página (pode ter mudado)
        const pageText = document.body.innerText || '';
        if (pageText.includes(cachedName) || pageText.match(new RegExp(`Jogador[:\\s]+${cachedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))) {
          if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ✅ Usando cache da aldeia ${villageKey}: "${cachedName}"`);
          __cachedPlayerName = cachedName; // Atualizar cache global também
          return cachedName;
        }
      }

      // Método 1: Procurar no texto "Jogador: Nome" na página de aldeia
      // Este é o método mais confiável pois está diretamente na página da aldeia
      const playerTextMatch = document.body.innerText.match(/Jogador[:\s]+([^\n\r]+)/i);
      if (playerTextMatch && playerTextMatch[1]) {
        let name = playerTextMatch[1].trim().split(/[\n\r\t]/)[0].trim();
        if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] Nome encontrado (método 1): "${name}"`);

        // Decodificar HTML entities e normalizar
        if (name.includes('&')) {
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = name;
          name = tempDiv.textContent || tempDiv.innerText || name;
          if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] Após HTML entities: "${name}"`);
        }
        // Decodificar URL encoding se necessário
        try {
          const decoded = decodeURIComponent(name);
          if (decoded !== name) {
            name = decoded;
            if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] Após URL decode: "${name}"`);
          }
        } catch (e) {
          // Se falhar, usar como está
        }
        name = normalizeName(name);
        if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] Após normalize: "${name}"`);

        if (name && name.length > 2 && name.length < 50 && !/desconhecido|unknown/i.test(name)) {
          // IMPORTANTE: Atualizar cache global E cache por aldeia
          if (__cachedPlayerName && __cachedPlayerName !== name) {
            if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ⚠️ Cache global atualizado: "${__cachedPlayerName}" → "${name}"`);
          }
          __cachedPlayerName = name;

          // Cache por aldeia (resolve problema de modo de férias)
          if (villageKey) {
            __villagePlayerNameCache.set(villageKey, name);
            if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] 💾 Cache da aldeia ${villageKey} atualizado: "${name}"`);
          }

          if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ✅ Retornando: "${name}"`);
          return name;
        }
      }

      // Método 2: Procurar em elementos específicos da página de aldeia
      const villageInfoSelectors = [
        '.village_info',
        '#content_value .village_info',
        'table.vis tr:has(td:contains("Jogador"))',
        '#content_value table tr'
      ];

      for (const selector of villageInfoSelectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements).slice(0, 10)) {
            const text = (el.textContent || '').trim();
            const playerMatch = text.match(/Jogador[:\s]+([^\n\r]+)/i);
            if (playerMatch && playerMatch[1]) {
              let name = playerMatch[1].trim().split(/[\n\r\t]/)[0].trim();
              if (name.includes('&')) {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = name;
                name = tempDiv.textContent || tempDiv.innerText || name;
              }
              try {
                const decoded = decodeURIComponent(name);
                if (decoded !== name) name = decoded;
              } catch (e) {}
              name = normalizeName(name);
              if (name && name.length > 2 && name.length < 50 && !/desconhecido|unknown/i.test(name)) {
                if (__cachedPlayerName && __cachedPlayerName !== name) {
                  if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ⚠️ Cache atualizado (método 2): "${__cachedPlayerName}" → "${name}"`);
                }
                __cachedPlayerName = name;
                if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ✅ Retornando (método 2): "${name}"`);
                return name;
              }
            }
          }
        } catch (e) { continue; }
      }

      // Método 3: Tentar usar dados do mundo se disponível
      if (MUNDO_DADOS && MUNDO_DADOS.loaded && __cachedPlayerId) {
        const nameFromWorld = getPlayerNameFromWorldData(__cachedPlayerId);
        if (nameFromWorld) {
          const normalized = normalizeName(nameFromWorld);
          if (normalized && normalized !== 'Jogador Desconhecido') {
            if (__cachedPlayerName && __cachedPlayerName !== normalized) {
              if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ⚠️ Cache atualizado (método 3): "${__cachedPlayerName}" → "${normalized}"`);
            }
            __cachedPlayerName = normalized;
            if (cfg.debug) dlog(`[getPlayerNameFromVillagePage] ✅ Retornando (método 3): "${normalized}"`);
            return normalized;
          }
        }
      }

      return null;
    } catch (e) {
      if (cfg.debug) dlog('[getPlayerNameFromVillagePage] Erro:', e);
      return null;
    }
  }

  // Função desabilitada na versão minimal - script Players não deve mostrar nada
  function displayAttacksForVillage(villageCoords, attacks) {
    // VERSÃO MINIMAL: Não exibir nada, apenas coletar e enviar dados
    return;
    // Remover painel anterior se existir
    const existingPanel = document.getElementById('rv-village-attacks-panel');
    if (existingPanel) {
      existingPanel.remove();
    }

    if (!attacks || attacks.length === 0) {
      return;
    }

    const now = Date.now();
    const futureAttacks = attacks
      .filter(a => (a.arrival_at || 0) > now)
      .sort((a, b) => {
          let timeA = Number(a.arrival_at);
          let timeB = Number(b.arrival_at);
          if (isNaN(timeA)) timeA = parseArrivalAbsolute(a.arrival_at);
          if (isNaN(timeB)) timeB = parseArrivalAbsolute(b.arrival_at);
          if (timeA !== timeB) return timeA - timeB;
          const idA = a.command_id ? String(a.command_id) : '0';
          const idB = b.command_id ? String(b.command_id) : '0';
          return idA.localeCompare(idB, undefined, { numeric: true });
      });

    if (futureAttacks.length === 0) {
      return;
    }

    dlog(`Exibindo ${futureAttacks.length} ataques para aldeia ${villageCoords.x}|${villageCoords.y}`);

    // Limite de ataques visíveis por vez (com scroll)
    const MAX_VISIBLE_ATTACKS = 15;
    const nobleCount = futureAttacks.filter(a =>
      a.type === 'noble' || (a.icon_alt || '').toLowerCase().includes('noble')
    ).length;

    // Criar painel
    const panel = document.createElement('div');
    panel.id = 'rv-village-attacks-panel';

    // Usar o mesmo formato de renderização do painel principal
    panel.innerHTML = `
      <div class="rv-village-header-integrated">
        <div class="rv-village-header-left">
          <button class="rv-collapse-btn" type="button" title="Colapsar/Expandir">▸</button>
          <h3>🛡️ Ataques Recebendo - Aldeia ${villageCoords.x}|${villageCoords.y}</h3>
        </div>
        <span class="rv-village-stats-integrated">Total: ${futureAttacks.length} ${nobleCount > 0 ? `| 👑 Nobres: ${nobleCount}` : ''} ${futureAttacks.length > MAX_VISIBLE_ATTACKS ? `| 📜 Use a rolagem para ver todos` : ''}</span>
      </div>
      <div class="rv-village-body-integrated hidden">
        <div class="rv-village-table-wrapper-integrated">
          <table class="tw-blue-elves-table">
            ${colgroupHTML()}
            <thead>
              <tr>
                <th><img src="${esc(DEFAULT_AXE_ICON)}" style="height:16px;width:16px;image-rendering:pixelated" alt="Machado"></th>
                <th>Comando</th>
                <th>Destino</th>
                <th>Defensor</th>
                <th>Origem</th>
                <th>Atacante</th>
                <th>Chegada</th>
                <th>Chega em</th>
              </tr>
            </thead>
            <tbody id="rv-village-tbody">
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Renderizar TODAS as linhas (mas o scroll limita a visualização)
    const tbody = panel.querySelector('#rv-village-tbody');
    const frag = document.createDocumentFragment();

    // Renderizar todos os ataques (não limitar, deixar o scroll fazer o trabalho)
    for (const a of futureAttacks) {
      const tr = document.createElement('tr');
      const isIgnored = ignoredCombined.has(String(a.command_id));
      if (isIgnored) {
        tr.classList.add('tw-row-ignored');
        if (!cfg.showIgnored) tr.style.display = 'none';
      }

      // Ícone
      const tdIcon = document.createElement('td');
      const axeSrc = a.icon_src || DEFAULT_AXE_ICON;
      const isProv = getAxeType(a) === 'small_medium';
      tdIcon.innerHTML = isProv
        ? `<div class="tw-axe-ctr" title="Small/Medium (provisório)"><span class="stack" style="display:inline-flex;gap:2px;align-items:center"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'small'))}"><img src="${esc(buildIconVariant(DEFAULT_AXE_ICON,'medium'))}"></span></div>`
        : `<div class="tw-axe-ctr" title="${esc(a.icon_key||'attack')}"><img src="${esc(axeSrc)}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_AXE_ICON}';"/>${a.watchtower ? '<span class="num" title="Watchtower">👁</span>' : ''}</div>`;
      tr.appendChild(tdIcon);

      // Tipo (com cores)
      const tdType = document.createElement('td');
      const typeText = a.type || '';
      // Adicionar ícone de nobre antes de "Nobre" quando for um nobre recebido
      if (isNoble(a)) {
        tdType.innerHTML = `<img src="${esc(NOBLE_ICON)}" alt="Nobre" style="width: 16px; height: 16px; vertical-align: middle; margin-right: 4px; display: inline-block;">${esc(typeText)}`;
      } else {
        tdType.textContent = typeText;
      }
      if (cfg.colorizeEnabled) {
        let style = '';
        if (isSupport(a)) {
          style = 'background:yellow;color:black;font-weight:bold;';
        } else {
          const c = getCommandColor(a.type);
          if (c) style = `background:${c.background};color:${c.color};font-weight:bold;`;
        }
        tdType.style = style;
        tdType.classList.add('command-colored');
      }
      tr.appendChild(tdType);

      // Outras colunas
      [a.target, a.defender, a.origin, a.attacker].forEach(val => {
        const td = document.createElement('td');
        td.textContent = val || '';
        tr.appendChild(td);
      });

      // Chegada
      const tdArr = document.createElement('td');
      tdArr.textContent = (a.arrival_text || '').replace(/\(atual\)/i, '').trim();
      if (!tdArr.textContent) {
        const arrivalDate = new Date(a.arrival_at);
        if (!isNaN(arrivalDate.getTime())) {
          const today = new Date();
          const isToday = arrivalDate.toDateString() === today.toDateString();
          if (isToday) {
            tdArr.textContent = `hoje às ${arrivalDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
          } else {
            tdArr.textContent = arrivalDate.toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          }
        }
      }
      tr.appendChild(tdArr);

      // Chega em (countdown)
      const tdEta = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'tw-blue-elves-pill tw-countdown';
      pill.dataset.arrival = String(Math.floor((a.arrival_at || 0) / 1000));
      const timeLeft = Math.floor((a.arrival_at - now) / 1000);
      if (timeLeft > 0) {
        const hours = Math.floor(timeLeft / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        const seconds = timeLeft % 60;
        pill.textContent = hours > 0
          ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
          : `${minutes}:${String(seconds).padStart(2, '0')}`;
      } else {
        pill.textContent = 'CHEGOU';
      }
      tdEta.appendChild(pill);
      tr.appendChild(tdEta);

      tr.setAttribute('data-arrival', a.arrival_at);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);

    // Adicionar estilos se ainda não foram adicionados
    if (!document.getElementById('rv-village-styles')) {
      const style = document.createElement('style');
      style.id = 'rv-village-styles';
      style.textContent = `
        /* Painel integrado naturalmente na página - estilo do jogo */
        #rv-village-attacks-panel {
          margin-bottom: 15px;
          margin-top: 10px;
          background: #e8e6e4;
          border: 1px solid #a8a39d;
          border-radius: 4px;
          padding: 8px;
          box-sizing: border-box;
          max-width: 100%;
          width: auto;
        }
        .rv-village-header-integrated {
          background: #c4c0bb;
          color: #2b1a0f;
          padding: 8px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #a8a39d;
          margin-bottom: 5px;
        }
        .rv-village-header-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .rv-collapse-btn {
          background: transparent;
          border: 1px solid #a8a39d;
          color: #2b1a0f;
          width: 24px;
          height: 24px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          font-weight: bold;
        }
        .rv-collapse-btn:hover {
          background: rgba(123, 74, 22, 0.1);
        }
        .rv-village-header-integrated h3 {
          margin: 0;
          font-size: 14px;
          font-weight: bold;
        }
        .rv-village-body-integrated {
          display: block;
        }
        .rv-village-body-integrated.hidden {
          display: none;
        }
        .rv-village-stats-integrated {
          font-size: 12px;
          font-weight: bold;
        }
        .rv-village-table-wrapper-integrated {
          overflow-x: auto;
          overflow-y: auto;
          max-height: 525px;
          position: relative;
          scrollbar-width: thin;
          scrollbar-color: #a8a39d #e8e6e4;
        }
        .rv-village-table-wrapper-integrated::-webkit-scrollbar {
          width: 12px;
          height: 12px;
        }
        .rv-village-table-wrapper-integrated::-webkit-scrollbar-track {
          background: #e8e6e4;
          border-radius: 6px;
        }
        .rv-village-table-wrapper-integrated::-webkit-scrollbar-thumb {
          background: #a8a39d;
          border-radius: 6px;
          border: 2px solid #e8e6e4;
        }
        .rv-village-table-wrapper-integrated::-webkit-scrollbar-thumb:hover {
          background: #5a3a10;
        }
        #rv-village-attacks-panel .tw-blue-elves-table {
          width: 100%;
          border-collapse: collapse;
          background: #e8e6e4 !important;
          border: 1px solid #a8a39d;
        }
        #rv-village-attacks-panel .tw-blue-elves-table th {
          background: #c4c0bb;
          color: #2b1a0f;
          border-bottom: 1px solid #a8a39d;
        }
        #rv-village-attacks-panel .tw-blue-elves-table th,
        #rv-village-attacks-panel .tw-blue-elves-table td {
          padding: 6px 8px;
          border-bottom: 1px solid #d5d2ce;
          white-space: nowrap;
          font-size: 12px;
        }
        #rv-village-attacks-panel .tw-blue-elves-table tr:nth-child(even) td {
          background: #f9f1d7;
        }
        #rv-village-attacks-panel .tw-blue-elves-table tbody tr:hover {
          background: #f8f8f8;
        }
        #rv-village-attacks-panel .tw-blue-elves-table .tw-blue-elves-pill {
          display: inline-block;
          padding: 2px 6px;
          border-radius: 6px;
          background: #333;
          color: #fff;
          font-size: 11px;
          border: 1px solid rgba(0,0,0,.1);
          font-weight: bold;
          min-width: 60px;
          text-align: center;
        }
        #rv-village-attacks-panel .tw-row-ignored {
          opacity: .55;
        }
        html:not(.tw-show-ignored) #rv-village-attacks-panel .tw-row-ignored {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }

    // PRIORIDADE: Inserir acima de #content_value > h2 (como solicitado pelo usuário)
    let insertPoint = null;

    // Método 1: Buscar especificamente por #content_value > h2
    const targetH2 = document.querySelector('#content_value > h2');
    if (targetH2 && targetH2.parentElement) {
      targetH2.parentElement.insertBefore(panel, targetH2);
      insertPoint = 'above_content_h2';
      dlog('Painel inserido acima de #content_value > h2');
    }

    // Método 2: Se não encontrou, buscar por headings com texto "Próprios comandos"
    if (!insertPoint) {
      const allHeadings = document.querySelectorAll('#content_value h2, #content_value h3, #content_value h4');
      for (const heading of allHeadings) {
        const text = heading.textContent || '';
        if (text.includes('Próprios comandos')) {
          const parent = heading.parentElement;
          if (parent) {
            parent.insertBefore(panel, heading);
            insertPoint = 'above_commands_heading';
            dlog('Painel inserido acima do heading "Próprios comandos"');
            break;
          }
        }
      }
    }

    // Método 3: Buscar por tabelas de comandos com colunas específicas
    if (!insertPoint) {
      const tables = document.querySelectorAll('#content_value table.vis, #content_value table');
      for (const table of tables) {
        const headers = table.querySelectorAll('th');
        let hasChegada = false;
        let hasChegaEm = false;

        for (const header of headers) {
          const text = header.textContent || '';
          if (text.includes('Chegada') || text.includes('Chega')) hasChegada = true;
          if (text.includes('Chega em') || text.includes('Arrives in')) hasChegaEm = true;
        }

        if (hasChegada && hasChegaEm) {
          const parent = table.parentElement;
          if (parent) {
            parent.insertBefore(panel, table);
            insertPoint = 'above_commands_table';
            dlog('Painel inserido acima da tabela de comandos');
            break;
          }
        }
      }
    }

    // Método 4: Se ainda não encontrou, inserir no início de #content_value
    if (!insertPoint) {
      const contentArea = document.querySelector('#content_value');
      if (contentArea) {
        const firstChild = contentArea.firstElementChild;
        if (firstChild) {
          contentArea.insertBefore(panel, firstChild);
          insertPoint = 'content_value_start';
          dlog('Painel inserido no início de #content_value');
        } else {
          contentArea.appendChild(panel);
          insertPoint = 'content_value_end';
          dlog('Painel inserido no final de #content_value (sem filhos)');
        }
      }
    }

    // Método 5 (antigo 3): Buscar por elementos com classes relacionadas a comandos (fallback)
    if (!insertPoint) {
      const commandElements = document.querySelectorAll(
        '[class*="command"], [class*="incoming"], [id*="command"], [id*="incoming"], ' +
        '.commands_list, .incomings_table, #commands_list'
      );

      for (const el of commandElements) {
        const parent = el.parentElement;
        if (parent) {
          parent.insertBefore(panel, el);
          insertPoint = 'above_command_element';
          dlog('Painel inserido acima do elemento de comandos');
          break;
        }
      }
    }

    // Método 4: Buscar pela área de conteúdo principal e inserir no topo
    if (!insertPoint) {
      const contentArea = document.querySelector('#content_value, .content, .main-content, #game_body, [id*="content"], .game_content');
      if (contentArea) {
        // Tentar inserir após o primeiro elemento filho (que geralmente é o título/mapa)
        const firstChild = contentArea.firstElementChild;
        if (firstChild && firstChild.nextSibling) {
          contentArea.insertBefore(panel, firstChild.nextSibling);
          insertPoint = 'after_first_child';
          dlog('Painel inserido após o primeiro elemento do conteúdo');
        } else {
          contentArea.insertBefore(panel, contentArea.firstChild);
          insertPoint = 'content_top';
          dlog('Painel inserido no topo do conteúdo');
        }
      }
    }

    // Último recurso: inserir no body (garantir que apareça)
    if (!insertPoint) {
      const bodyContent = document.querySelector('body > div, #game_body, .wrapper');
      if (bodyContent) {
        bodyContent.insertBefore(panel, bodyContent.firstChild);
        insertPoint = 'body_content';
        dlog('Painel inserido no conteúdo do body');
      } else {
        document.body.appendChild(panel);
        insertPoint = 'body';
        dlog('Painel inserido no body (fallback final)');
      }
    }

    dlog(`Painel inserido com sucesso em: ${insertPoint}`);

    // Verificar se o painel foi realmente inserido no DOM
    if (!document.body.contains(panel)) {
      // logs removidos
      document.body.appendChild(panel);
      dlog('Painel inserido diretamente no body como último recurso');
    } else {
      dlog('Painel confirmado no DOM');
    }

    // Configurar botão de colapsar/expandir (INICIALMENTE MINIMIZADO)
    const collapseBtn = panel.querySelector('.rv-collapse-btn');
    const bodyDiv = panel.querySelector('.rv-village-body-integrated');
    let isCollapsed = true; // Padrão: minimizado

    if (collapseBtn && bodyDiv) {
      // Aplicar estado inicial minimizado
      bodyDiv.classList.add('hidden');
      collapseBtn.textContent = '▸';

      collapseBtn.addEventListener('click', () => {
        isCollapsed = !isCollapsed;
        bodyDiv.classList.toggle('hidden', isCollapsed);
        collapseBtn.textContent = isCollapsed ? '▸' : '▾';
      });
    }

    // Atualizar contador usando a mesma lógica do painel principal (tickCountdowns)
    if (!panel.updateIntervalId) {
      panel.updateIntervalId = setInterval(() => {
        if (isCollapsed) return; // Não atualizar se estiver colapsado

        const pills = panel.querySelectorAll('.tw-countdown');
        const now = Date.now();
        let hasFuture = false;

        pills.forEach(pill => {
          const arrivalUnix = parseInt(pill.dataset.arrival);
          if (!arrivalUnix) return;

          const arrivalMs = arrivalUnix * 1000;
          const timeLeft = Math.floor((arrivalMs - now) / 1000);

          if (timeLeft <= 0) {
            pill.textContent = 'CHEGOU';
            pill.style.background = '#b71c1c';
            pill.style.color = '#fff';
            hasFuture = false;
          } else {
            hasFuture = true;
            const hours = Math.floor(timeLeft / 3600);
            const minutes = Math.floor((timeLeft % 3600) / 60);
            const seconds = timeLeft % 60;
            pill.textContent = hours > 0
              ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
              : `${minutes}:${String(seconds).padStart(2, '0')}`;

            // Aplicar cores como no painel principal
            if (timeLeft <= 15*60) {
              pill.style.background = '#ff9800';
              pill.style.color = '#fff';
            } else if (timeLeft <= 60*60) {
              pill.style.background = '#ffeb3b';
              pill.style.color = '#000';
            } else {
              pill.style.background = '#333';
              pill.style.color = '#fff';
            }
          }
        });

        // Remover painel se não houver mais ataques futuros
        if (!hasFuture && pills.length === 0) {
          clearInterval(panel.updateIntervalId);
          panel.remove();
          panel.updateIntervalId = null;
        }
      }, 1000);
    }
  }

  // Função principal para verificar e exibir ataques da aldeia (busca automática quando em info_village)
  // VERSÃO MINIMAL: Função desabilitada - não há interface para mostrar ataques
  async function checkAndDisplayVillageAttacks() {
    // VERSÃO MINIMAL: Não exibe nada
    return;
  }

  // Função desabilitada na versão minimal (código mantido para referência)
  async function _checkAndDisplayVillageAttacks_OLD() {
    if (!isVillageInfoPage()) {
      // Remover painel se não estiver na página de aldeia
      const existingPanel = document.getElementById('rv-village-attacks-panel');
      if (existingPanel) {
        existingPanel.remove();
      }
      return;
    }

    const villageCoords = getVillageCoordsFromURL();
    if (!villageCoords) {
      dlog('Não foi possível obter coordenadas da aldeia');
      return;
    }

    dlog('Aldeia detectada - buscando dados automaticamente:', villageCoords);

    // BUSCAR DADOS AUTOMATICAMENTE quando estiver na página de aldeia
    try {
      const localAttacks = collectAttacksFromDOM();
      let serverAttacks = [];

      if (cfg.serverURL && cfg.authToken) {
        try {
          serverAttacks = await fetchAttacksFromServer();
          dlog(`📥 Recebendo ${serverAttacks.length} ataques do servidor (aldeia)`);
        } catch (e) {
          dlog('Erro ao buscar ataques do servidor:', e);
        }
      }

      // Combinar ataques locais e do servidor
      const uniqueAttacks = new Map();

      // Primeiro: adicionar TODOS os ataques do servidor (base)
      serverAttacks.forEach(attack => {
        if (attack.command_id) {
          uniqueAttacks.set(attack.command_id, attack);
        }
      });

      // Segundo: sobrescrever com ataques locais (prioridade local)
      localAttacks.forEach(attack => {
        if (attack.command_id) {
          uniqueAttacks.set(attack.command_id, attack);
        }
      });

      const allAttacks = Array.from(uniqueAttacks.values())
        .filter(a => (a.arrival_at||0) > Date.now()); // Apenas ataques futuros

      // Gatilho único: envio/coleta acontece no background sync (aqui não faz envio)

      // Filtrar ataques para esta aldeia
      const villageAttacks = allAttacks.filter(attack => {
        const targetCoords = normalizeTargetCoords(attack.target);
        if (!targetCoords) return false;
        return targetCoords.x === villageCoords.x && targetCoords.y === villageCoords.y;
      });

      dlog(`Encontrados ${villageAttacks.length} ataques para aldeia ${villageCoords.x}|${villageCoords.y}`);

      // VERSÃO MINIMAL: Não exibir nada, apenas coletar e enviar dados
      // Os ataques já foram enviados para o servidor acima (netQueueAdd)
    } catch (e) {
      dlog('Erro ao buscar ataques para aldeia:', e);
    }
  }

  // ===== SISTEMA DE PAUSA E RATE LIMITING =====
  let __uiCollapsed = false;
  let __uiOnScreen = true;
  let __lastActive = Date.now();

  function isPaused() {
    // NUNCA pausar o envio de dados - sempre enviar em background
    // Só pausar a recepção quando UI não está visível
    if (__uiCollapsed) return true;      // UI colapsada - não receber dados
    if (!__uiOnScreen) return true;      // Fora da tela - não receber dados
    return false;
  }

  // Rate limit (token bucket) – alvo < 1/s para 200 jogadores
  const RATE_LIMIT_MAX_TOKENS = 3;
  const RATE_LIMIT_REFILL_PER_SEC = 1;
  let __tokens = RATE_LIMIT_MAX_TOKENS;
  setInterval(() => {
    __tokens = Math.min(RATE_LIMIT_MAX_TOKENS, __tokens + RATE_LIMIT_REFILL_PER_SEC);
  }, 1000);

  async function rateLimitFetch(input, init) {
    while (__tokens <= 0 || isPaused() || isCaptchaPage()) {
      await new Promise(r => setTimeout(r, 200));
    }
    __tokens--;
    return fetch(input, init);
  }

  let __backgroundSyncTimer = null;
  let __serverDataTimer = null; // Timer específico para baixar dados do servidor

  function startBackgroundSync() {
    if (__beBlocked) return;
    if (__backgroundSyncTimer) {
      return;
    }

    // Inicializar BroadcastChannel se ainda não foi inicializado
    if (!__broadcastChannel) {
      initBroadcastChannel();
    } else {
      updateSpecialPageFlag();
    }

    const run = async () => {
      try {
        // 1) Heartbeat primeiro: servidor decide qual aba é a sessão ATIVA
        try { await sendHeartbeat(); } catch {}

        const serverConfigured = !!(cfg.serverURL && cfg.authToken);

        // Verificar se pode coletar dados (aba ativa ou página especial)
        let canCollect = true;
        if (serverConfigured) {
          // Aba bloqueada nunca coleta
          if (__beBlocked && !__isSpecialPage) {
            dlog('⏸ [Background] Aba bloqueada pelo servidor — não vai coletar dados.');
            canCollect = false;
          }
          // Se não é sessão ativa (segundo o servidor) e não é página especial, não coleta
          else if (!__beSessionActive && !__isSpecialPage) {
            dlog('⏸ [Background] Esta aba não é a sessão ativa — não vai coletar dados.');
            canCollect = false;
          }
        }

        // 2) Coletar ataques recebidos de TODAS as páginas
        // MAS: se página de incomings está aberta, pular (usa DOM direto)
        if (canCollect && !isIncomingsPage()) {
          const attacks = await collectAttacksFromAllPages();
          if (attacks.length > 0) {
            dlog(`✅ [Background] ${attacks.length} ataques recebidos coletados de todas as páginas`);
            setTimeout(() => {
              netQueueAdd(attacks);
            }, Math.random() * 2000);
          }
        } else if (isIncomingsPage()) {
          dlog('Background sync: página de incomings aberta, pulando coleta (usa DOM direto)');
        }

        // 3) Coletar comandos enviados de TODAS as páginas
        // MAS: se página de comandos está aberta, pular (usa DOM direto via startPageSync)
        // E: só coleta se for aba ativa ou página especial
        if (canCollect && !isCommandsPage()) {
          const commands = await collectCommandsFromAllPages();
          if (commands.length > 0) {
            dlog(`✅ [Background] ${commands.length} comandos enviados coletados de todas as páginas`);
            setTimeout(() => {
              commandsQueueAdd(commands);
            }, Math.random() * 2000 + 1000); // Delay adicional para não sobrecarregar
          }
        } else if (isCommandsPage()) {
          dlog('Background sync: página de comandos aberta, pulando coleta (usa DOM direto)');
        }

        } catch (e) {
            dlog('Background sync: erro na coleta universal:', e);
        }
    };

    // Executar imediatamente
    run();

    // Executar a cada 7min ± 60s (humanizado)
    const scheduleNext = () => {
      if (__beBlocked) return;
      const delay = __beHumanInterval(420000, 60000);
      __backgroundSyncTimer = setTimeout(async () => {
        __backgroundSyncTimer = null;
        await run();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  // Função para baixar dados do servidor em background (mesmo com painel fechado)
  function startServerDataFetch() {
    // VERSÃO MINIMAL: Desabilitado - não busca dados do servidor
    return;

    /* CÓDIGO DESABILITADO - VERSÃO MINIMAL
    if (__serverDataTimer) return;

    const fetchServerData = async () => {
      if (!cfg.serverURL || !cfg.authToken) return;

      try {
        const serverAttacks = await fetchAttacksFromServer();
        dlog(`📥 Background: ${serverAttacks.length} ataques do servidor (painel fechado)`);

        // Atualizar cache apenas com dados do servidor
        const uniqueAttacks = new Map();
        serverAttacks.forEach(attack => {
          if (attack.command_id) {
            uniqueAttacks.set(attack.command_id, attack);
          }
        });
        cache = Array.from(uniqueAttacks.values())
          .filter(a => (a.arrival_at||0) > Date.now());

        // Atualizar badge de nobres mesmo com painel fechado
        updateNobleBadge();
      } catch (e) {
        dlog('Erro ao buscar dados do servidor (background):', e);
      }
    };

    // Executar imediatamente
    fetchServerData();

    // Executar a cada 90 segundos (menos frequente que quando painel está aberto)
    __serverDataTimer = setInterval(fetchServerData, 90000);
    */
  }

  function stopServerDataFetch() {
    if (__serverDataTimer) {
      clearInterval(__serverDataTimer);
      __serverDataTimer = null;
    }
  }

  async function scheduleIgnoredSyncers() {
    try {
      // Buscar lista de ignorados do servidor
      const serverIgnored = await fetchIgnoredFromServer();
      dlog(`Servidor: ${serverIgnored.size} jogadores ignorados`);

      // Sincronizar com servidor
    await syncIgnoredWithServer();

      // Atualizar lista combinada
    await refreshIgnoredCombined();
    } catch (e) {
      dlog('Erro na sincronização de ignorados:', e);
      // Fallback para modo local
      await refreshIgnoredCombined();
    }
  }

  function ensureConfig(){
    if (!cfg.world) {
      const w=prompt('Mundo (ex br142):', hostWorld || 'br142');
      if (w!=null && w.trim()){ cfg.world=w.toLowerCase().trim(); GM_setValue('tw_world', cfg.world); }
    }
    if (!cfg.world) throw new Error('Mundo não configurado');

    // Configurar servidor se não estiver configurado
    if (!cfg.serverURL || !cfg.authToken) {
      const serverUrl = prompt('URL do servidor (ex: https://fellas.centraltw.com.br):', cfg.serverURL || '');
      if (serverUrl && serverUrl.trim()) {
        cfg.serverURL = serverUrl.trim();
        GM_setValue('tw_serverURL', cfg.serverURL);
      }

      if (cfg.serverURL && !cfg.authToken) {
        const authToken = prompt('Token de autenticação:', cfg.authToken || '');
        if (authToken && authToken.trim()) {
          cfg.authToken = authToken.trim();
          GM_setValue('tw_authToken', cfg.authToken);
        }
      }
    }
  }

  // ===== SISTEMA DE ENGINES E VIEWPORT OBSERVER =====
  let __io;
  function attachViewportObserver(el) {
    try {
      __io?.disconnect();
      __io = new IntersectionObserver((entries) => {
        __uiOnScreen = entries.some(e => e.isIntersecting && e.intersectionRatio > 0.08);
        updateEngines();
      }, { threshold: [0, 0.08, 0.25, 0.5, 0.75, 1] });
      if (el) __io.observe(el);
    } catch {}
  }

  function updateEngines() {
    // VERSÃO MINIMAL: Não tem interface, então não precisa buscar dados
    // Sempre manter background sync ativo (envio de dados)
    // Não buscar dados do servidor (desabilitado)
    stopServerDataFetch();
    stopSync();
    stopTick();
    __lastActive = Date.now();
  }

  document.addEventListener('visibilitychange', updateEngines);

  // ===== SISTEMA DE HEARTBEAT PARA PAINEL DE PLAYERS =====
  let __heartbeatTimer = null;

  async function sendHeartbeat() {
    // Páginas especiais podem enviar mesmo se bloqueadas por outras abas normais
    if (__beBlocked && !__isSpecialPage) return;

    // Se é página especial e está enviando, notificar outras abas
    if (__isSpecialPage && !__isSendingActive) {
      notifySpecialPageActive();
    }
    if (!cfg.serverURL || !cfg.authToken) {
      if (cfg.debug) dlog('Heartbeat: servidor não configurado (serverURL ou authToken faltando)');
      return;
    }

    // Identidade obtida via cache persistente (sem carregar banco de dados do mundo)
    // loadWorldData() só é chamado sob demanda (ex: mapa) ou como último recurso em __beGetIdentity()

    let playerName = getLoggedPlayerName();
    if (!playerName) {
      if (cfg.debug) dlog('Heartbeat: nome do jogador não encontrado');
      return;
    }

    // Normalizar nome antes de enviar (garantir que não tenha "+" no lugar de espaços)
    playerName = normalizeName(playerName);

    try {
      updateStatusIndicator('twInlineBtn', 'pending');
      // Obter player_id primeiro (método mais seguro)
      if (!__cachedPlayerId) {
        __cachedPlayerId = getPlayerIdFromScripts();
        if (cfg.debug) dlog(`💓 Heartbeat: Player ID obtido: ${__cachedPlayerId || 'NÃO ENCONTRADO'}`);
      }

      // Obter tag da tribo do player logado
      const triboTag = getLoggedPlayerTribeTag();
      if (cfg.debug) {
        dlog(`💓 Heartbeat: Player: ${playerName}, ID: ${__cachedPlayerId || 'N/A'}, Tribo: ${triboTag || 'NULL'}`);
      }

      const playerData = {
        world: cfg.world,
        player: playerName,
        playerId: __cachedPlayerId || null,
        sessionId: SESSION_ID,
        lastSeen: Date.now(),
        version: VERSION_TEXT,
        userAgent: navigator.userAgent.substring(0, 100), // Limitado para privacidade
        triboTag: triboTag || null,
        isSpecialPage: __isSpecialPage // Flag para páginas especiais (incomings/commands)
      };

      if (cfg.debug) dlog(`💓 Enviando heartbeat: ${playerData.player} (${cfg.world}) para ${cfg.serverURL}/api/heartbeat`);

      const response = await rateLimitFetch(`${cfg.serverURL}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': SESSION_ID },
        body: JSON.stringify(playerData)
      });

      if (response.status === 429) {
        // Páginas especiais podem tentar mesmo com 429
        if (__isSpecialPage) {
          dlog('⚠️ [Heartbeat] Status 429 recebido, mas página especial continua tentando');
          // Não bloqueia - deixa o servidor decidir
        } else {
          await __beLogBlockedOnce('outra aba');
          __beStopSendingOnly();
          return;
        }
      }
      if (!response.ok) {
        // Sem logs extras (pedido do usuário)
        updateStatusIndicator('twInlineBtn', 'error');
        return;
      }

      const responseData = await response.json().catch(() => ({}));
      __beMarkActiveAndLogIfNeeded();
      updateStatusIndicator('twInlineBtn', 'success');
    } catch (e) {
      // Sem logs extras (pedido do usuário)
      updateStatusIndicator('twInlineBtn', 'error');
    }
  }

  function startHeartbeat() {
    // Heartbeat agora é disparado junto do ciclo do background sync (1x por ciclo).
    // Mantemos esta função para compatibilidade, mas sem timer próprio.
    if (__heartbeatTimer) return;
    __heartbeatTimer = true; // marcador (não é um interval)
  }

  function stopHeartbeat() {
    __heartbeatTimer = null;
  }

  // Sistema de coleta rápida quando página está aberta (15s)
  function startPageSync() {
    // Coleta rápida para página de incomings
    if (isIncomingsPage() && !__incomingsPageTimer) {
      const collectIncomings = async () => {
        try {
          // 1. Coletar do DOM (página atual) - rápido, a cada 15s
          const attacks = collectAttacksFromDOM();
          if (attacks.length > 0) {
            netQueueAdd(attacks);
          }
        } catch (e) {
          dlog('Erro na coleta rápida de incomings:', e);
        }
      };

      // Função separada para buscar páginas adicionais (background sync interval)
      const checkAndFetchAdditionalPages = async () => {
        try {
          // Verificar se há mais páginas disponíveis
          const pageInfo = detectMorePagesFromPagination('incomings', 'unignored');

          if (pageInfo.hasMore && pageInfo.maxPage >= 0 && pageInfo.maxPage > pageInfo.currentPage) {
            const startPage = pageInfo.currentPage + 1;
            const endPage = pageInfo.maxPage;

            // Buscar páginas adicionais em background (sem bloquear)
            collectAttacksFromPages(startPage, endPage).then(additionalAttacks => {
              if (additionalAttacks.length > 0) {
                netQueueAdd(additionalAttacks);
              }
            }).catch(e => {
              dlog('Erro ao buscar páginas adicionais de incomings:', e);
            });
          }
        } catch (e) {
          dlog('Erro ao verificar páginas adicionais de incomings:', e);
        }
      };

      // Executar coleta do DOM imediatamente e a cada 15 segundos
      collectIncomings();
      __incomingsPageTimer = setInterval(collectIncomings, 15000);

      // Executar busca de páginas adicionais imediatamente e depois no intervalo do background sync
      checkAndFetchAdditionalPages();
      const scheduleNextPagesCheck = () => {
        if (__incomingsPagesTimer) return; // Evitar múltiplos timers
        const delay = __beHumanInterval(420000, 60000); // 7min ± 60s
        __incomingsPagesTimer = setTimeout(() => {
          __incomingsPagesTimer = null;
          if (isIncomingsPage()) {
            checkAndFetchAdditionalPages();
            scheduleNextPagesCheck();
          }
        }, delay);
      };
      scheduleNextPagesCheck();
    }

    // Coleta rápida para página de comandos enviados
    if (isCommandsPage() && !__commandsPageTimer) {
      const collectCommands = async () => {
        try {
          // 1. Coletar do DOM (página atual) - rápido, a cada 15s
          const commands = collectCommandsFromDocument(document);
          if (commands.length > 0) {
            commandsQueueAdd(commands);
          }
        } catch (e) {
          dlog('Erro na coleta rápida de comandos:', e);
        }
      };

      // Função separada para buscar páginas adicionais (background sync interval)
      const checkAndFetchAdditionalPages = async () => {
        try {
          // Verificar se há mais páginas disponíveis
          const pageInfo = detectMorePagesCommandsFromPagination();

          if (pageInfo.hasMore && pageInfo.maxPage >= 0 && pageInfo.maxPage > pageInfo.currentPage) {
            const startPage = pageInfo.currentPage + 1;
            const endPage = pageInfo.maxPage;

            // Buscar páginas adicionais em background (sem bloquear)
            collectCommandsFromPages(startPage, endPage).then(additionalCommands => {
              if (additionalCommands.length > 0) {
                commandsQueueAdd(additionalCommands);
              }
            }).catch(e => {
              dlog('Erro ao buscar páginas adicionais de commands:', e);
            });
          }
        } catch (e) {
          dlog('Erro ao verificar páginas adicionais de commands:', e);
        }
      };

      // Executar coleta do DOM imediatamente e a cada 15 segundos
      collectCommands();
      __commandsPageTimer = setInterval(collectCommands, 15000);

      // Executar busca de páginas adicionais imediatamente e depois no intervalo do background sync
      checkAndFetchAdditionalPages();
      const scheduleNextPagesCheck = () => {
        if (__commandsPagesTimer) return; // Evitar múltiplos timers
        const delay = __beHumanInterval(420000, 60000); // 7min ± 60s
        __commandsPagesTimer = setTimeout(() => {
          __commandsPagesTimer = null;
          if (isCommandsPage()) {
            checkAndFetchAdditionalPages();
            scheduleNextPagesCheck();
          }
        }, delay);
      };
      scheduleNextPagesCheck();
    }
  }

  function stopPageSync() {
    if (__incomingsPageTimer) {
      clearInterval(__incomingsPageTimer);
      __incomingsPageTimer = null;
      dlog('⏸️ [PageSync] Coleta rápida de incomings pausada');
    }
    if (__commandsPageTimer) {
      clearInterval(__commandsPageTimer);
      __commandsPageTimer = null;
      dlog('⏸️ [PageSync] Coleta rápida de comandos pausada');
    }
    if (__incomingsPagesTimer) {
      clearTimeout(__incomingsPagesTimer);
      __incomingsPagesTimer = null;
    }
    if (__commandsPagesTimer) {
      clearTimeout(__commandsPagesTimer);
      __commandsPagesTimer = null;
    }
  }

  // Monitorar mudanças de página
  let __lastPageCheck = '';
  function checkPageChange() {
    const currentPage = isIncomingsPage() ? 'incomings' : (isCommandsPage() ? 'commands' : 'other');
    if (currentPage !== __lastPageCheck) {
      __lastPageCheck = currentPage;
      stopPageSync();
      startPageSync();
    }
  }

  // ============================================================
  // FUNÇÕES PARA ENVIO MANUAL DE COMANDOS ENVIADOS
  // ============================================================

  // Função para criar modal/pop-up de confirmação
  function showCommandsSendModal(onConfirm) {
    // Remover modal existente se houver
    const existingModal = document.getElementById('be-commands-send-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'be-commands-send-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: white;
      padding: 30px;
      border-radius: 8px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;

    content.innerHTML = `
      <h3 style="margin-top: 0; color: #333;">📤 Enviar Comandos ao Servidor <strong>FELLAS</strong></h3>
      <p style="color: #666; margin: 15px 0;">Deseja coletar e enviar seus comandos enviados ao servidor em background?</p>
      <p style="color: #555; font-size: 12px; margin: 10px 0; background: #fff8e1; padding: 10px; border-left: 3px solid #f0ad4e; border-radius: 3px;">⚔️ Esses dados ficam disponíveis para a <strong>Liderança</strong> conferir os envios, distribuição de ataques e nobres.</p>
      <p style="color: #999; font-size: 11px; margin: 10px 0;">O script irá varrer todas as páginas de comandos e enviá-los automaticamente em segundo plano.</p>
      <p style="color: #999; font-size: 11px; margin: 10px 0;"><strong>DICA:</strong> Após enviados todos os seus comandos da Operação, coloque para enviar os seus comandos e deixe alguns minutos nessa página para não ter falha no envio. 5 minutos é mais que suficiente!</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
        <button id="be-modal-cancel" style="padding: 8px 20px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancelar</button>
        <button id="be-modal-confirm" style="padding: 8px 20px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Confirmar Envio</button>
      </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    const cancelBtn = content.querySelector('#be-modal-cancel');
    const confirmBtn = content.querySelector('#be-modal-confirm');

    cancelBtn.onclick = () => modal.remove();
    confirmBtn.onclick = () => {
      modal.remove();
      if (onConfirm) onConfirm();
    };

    // Fechar ao clicar fora
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
  }

  // Função para coletar e enviar comandos enviados manualmente
  async function sendCommandsManually() {
    try {
      __beBlocked = false; // Desbloqueia temporariamente para o envio manual de comandos
      dlog('📤 [Manual] Iniciando coleta manual de comandos enviados...');

      // Mostrar feedback visual
      const statusEl = document.getElementById('be-commands-send-status');
      if (statusEl) {
        statusEl.textContent = '⏳ Coletando comandos...';
        statusEl.style.color = '#ff9800';
      }

      // Coletar comandos de todas as páginas
      const commands = await collectCommandsFromAllPages();
      dlog(`📤 [Manual] ${commands.length} comandos enviados coletados`);

      if (commands.length === 0) {
        if (statusEl) {
          statusEl.textContent = 'ℹ️ Nenhum comando encontrado';
          statusEl.style.color = '#6c757d';
          setTimeout(() => statusEl.textContent = '', 3000);
        }
        return;
      }

      if (statusEl) {
        statusEl.textContent = `⏳ Enviando ${commands.length} comandos...`;
      }

      // Adicionar à fila e agendar envio
      commandsQueueAdd(commands);

      // Forçar flush imediato
      if (__commandsTimer) {
        clearTimeout(__commandsTimer);
        __commandsTimer = null;
      }
      scheduleCommandsFlush();

      if (statusEl) {
        statusEl.textContent = `✅ ${commands.length} comandos adicionados à fila`;
        statusEl.style.color = '#28a745';
        setTimeout(() => statusEl.textContent = '', 5000);
      }

      dlog(`✅ [Manual] ${commands.length} comandos adicionados à fila de envio`);
    } catch (e) {
      dlog('❌ [Manual] Erro ao enviar comandos manualmente:', e);
      const statusEl = document.getElementById('be-commands-send-status');
      if (statusEl) {
        statusEl.textContent = '❌ Erro ao enviar';
        statusEl.style.color = '#dc3545';
        setTimeout(() => statusEl.textContent = '', 5000);
      }
    }
  }

  // Função para criar botão lateral
  function createSideButton(id, iconType, title, onClick) {
    // Verificar se já existe
    if (document.getElementById(id)) return document.getElementById(id);

    const container = document.querySelector('#questlog_new');
    const btn = document.createElement('div');
    btn.id = id;
    btn.className = 'quest';

    if (iconType === 'commands') {
      // Botão FL: bege estilo Tribal Wars, texto preto
      btn.textContent = 'FL';
      btn.style.fontSize = '11px';
      btn.style.fontWeight = '700';
      btn.style.letterSpacing = '0.5px';
      btn.style.lineHeight = '26px';
      btn.style.background = '#c8b48a';
      btn.style.color = '#000000';
      btn.style.border = '1.5px solid #5a3d0f';
      btn.style.borderRadius = '3px';
    }

    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.padding = '0';
    btn.style.width = '26px';
    btn.style.height = '26px';
    btn.title = title;
    btn.style.cursor = 'pointer';
    btn.style.position = 'relative';

    // Adicionar bolinha de status de rede
    const statusDot = document.createElement('div');
    statusDot.className = 'be-status-dot';
    statusDot.style.cssText = `
      position: absolute;
      top: 1px;
      left: 1px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: #28a745;
      border: 0.5px solid #000;
      z-index: 1002;
    `;
    btn.appendChild(statusDot);

    btn.addEventListener('click', onClick);

    // Inserir no DOM
    try {
      if (container) {
        container.appendChild(btn);
      } else {
        const anchor = document.getElementById('configScript');
        if (anchor) {
          anchor.insertAdjacentElement('afterend', btn);
        } else {
          const fallback = document.querySelector('#menu_row2, .menu-block, .menu-left') || document.body;
          if (fallback) {
            fallback.appendChild(btn);
          }
        }
      }
    } catch (e) {
      try {
        document.body.appendChild(btn);
      } catch (finalError) {
      }
    }

    return btn;
  }

  // Função para injetar botão lateral
  function injectCommandsSideButton() {
    if (document.getElementById('be-commands-send-btn')) return;

    const btn = createSideButton('be-commands-send-btn', 'commands', 'Script Fellas - Enviar comandos à Liderança', () => {
      showCommandsSendModal(() => {
        sendCommandsManually();
      });
    });

    // Adicionar status element (invisível por padrão)
    const statusEl = document.createElement('div');
    statusEl.id = 'be-commands-send-status';
    statusEl.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 10px 15px;
      border-radius: 4px;
      z-index: 999998;
      font-size: 12px;
      display: none;
    `;
    document.body.appendChild(statusEl);
  }






  function initialize(){
    // Limpeza inteligente de caches locais
    pruneExpiredCaches();

    // Logs exigidos (somente estes)
    __beLogBootOnce();
    __beLogSessionOnce();

    // Script carregado silenciosamente (debug desabilitado por padrão)

    // Limpar configurações antigas do servidor na inicialização (silencioso)
    if (cfg.serverURL && cfg.serverURL.includes('educational-johna-twserver')) {
      cfg.serverURL = '';
      cfg.authToken = '';
      GM_setValue('tw_serverURL', '');
      GM_setValue('tw_authToken', '');
    }

    // VERSÃO MINIMAL: Apenas envio de ataques, sem painel/UI
    scheduleIgnoredSyncers();
    startBackgroundSync();

    // Iniciar coleta rápida se página estiver aberta
    startPageSync();

    // Verificar mudanças de página a cada 5 segundos
    setInterval(checkPageChange, 5000);

    startHeartbeat(); // Iniciar heartbeat para painel de players

    // Adicionar botão lateral para envio manual de comandos
    setTimeout(() => {
      injectCommandsSideButton();
    }, 2000);

    // Atualização automática via Tampermonkey (@updateURL)
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();




  // VERSÃO MINIMAL: Não observa mudanças de URL (sem funcionalidade de aldeia)
})();