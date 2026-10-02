/*
 * Cunhagem APOSENTADOS — envio de recursos na proporção da moeda
 * --------------------------------------------------------------
 * Lê a visão de produção de todas as aldeias, calcula quanto cada uma pode mandar para a aldeia
 * escolhida respeitando mercadores e armazém, e despacha com um clique por aldeia.
 *
 * DECISÕES QUE VALEM SABER
 * ------------------------
 * 1. A pergunta da coordenada só aparece DEPOIS que a lista de aldeias chegou. Perguntar em
 *    paralelo com a busca deixa a lista vazia quando o jogador responde rápido, e sem erro na tela.
 *
 * 2. A linha só some quando o servidor CONFIRMA o envio; silêncio de 12 s também conta como falha.
 *    Remover a linha por relógio faz envio recusado sumir da tela igual a um que deu certo — falha
 *    silenciosa é o pior desfecho possível num script que move recurso.
 *
 * 3. Uma coleta só para computador e celular. A leitura é ancorada na célula de recursos e
 *    caminha pelos vizinhos, porque as duas telas trazem os mesmos campos em ORDEM DIFERENTE
 *    (ver o comentário em `coletar`). Ramos separados por layout envelhecem e divergem.
 *
 * 4. Aldeia cujos dados não foram lidos por completo NÃO entra na lista, e aparece num aviso.
 *    Mandar recurso errado não tem desfazer, então na dúvida o script se recusa a calcular.
 *
 * 5. A lista sai ORDENADA por distância (mais perto primeiro) e aceita uma TRAVA de alcance.
 *    O que fica além do limite some da tela — e, com isso, sai também do "Enviar tudo", que
 *    trabalha em cima do que está visível. Um lugar só para cortar.
 *
 * 6. Distância separa a coordenada no "|" em vez de fatiar por posição fixa — coordenada de 2
 *    dígitos quebraria o corte por índice.
 */
(function () {
    'use strict';
    // 8. Destino é aldeia SUA → envio pelo "Solicitar recursos" do jogo: UM pedido para todas as
    //    aldeias, ordenadas pelo tempo de viagem, respeitando o armazém do destino. Ver o bloco PUXAR.

    // ---------- proporção da moeda ----------
    /*
     * Custo de uma moeda no mundo. Se o seu mundo usar outro custo, mude aqui — a proporção é o
     * que decide quanto de cada recurso vai em cada transporte.
     */
    var CUSTO_MOEDA = { madeira: 28000, argila: 30000, ferro: 25000 };
    var TOTAL_MOEDA = CUSTO_MOEDA.madeira + CUSTO_MOEDA.argila + CUSTO_MOEDA.ferro;
    var PROP = {
        madeira: CUSTO_MOEDA.madeira / TOTAL_MOEDA,
        argila: CUSTO_MOEDA.argila / TOTAL_MOEDA,
        ferro: CUSTO_MOEDA.ferro / TOTAL_MOEDA
    };
    var CARGA_MERCADOR = 1000;

    var CHAVE_COORD = 'cunhagem_coordenada';
    var CHAVE_LIMITE = 'cunhagem_limite_pct';

    var aldeias = [];
    var problemas = [];
    var duplicadas = 0;
    var alvo = null;                 // { id, nome, imagem, jogador, pontos, x, y }
    var enviado = { madeira: 0, argila: 0, ferro: 0 };

    // ---------- utilidades ----------
    function limparNumero(txt) {
        // "254.236" e "254,236" viram 254236; devolve null quando não há dígito nenhum.
        var s = String(txt == null ? '' : txt).replace(/[^0-9]/g, '');
        return s === '' ? null : parseInt(s, 10);
    }
    function fmt(n) {
        return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }
    function lerPar(txt) {
        // "169/235" -> { usado: 169, total: 235 }
        var m = String(txt || '').replace(/\./g, '').match(/(\d+)\s*\/\s*(\d+)/);
        return m ? { usado: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
    }
    function distancia(x1, y1, x2, y2) {
        return Math.round(Math.hypot(x1 - x2, y1 - y2) * 10) / 10;
    }

    // ---------- coleta: um caminho só, desktop e celular ----------
    /*
     * A leitura é ancorada na célula de recursos da própria linha da aldeia e caminha para os
     * vizinhos. Isso vale nos dois layouts e sobrevive a coluna nova no meio — bem diferente de
     * `nextElementSibling` repetido quatro vezes, que quebra ao primeiro remanejo do jogo.
     */
    var SEL_MADEIRA = '.res.wood, .warn.wood, .warn_90.wood, .res.mwood, .warn.mwood, .warn_90.mwood';
    var SEL_ARGILA = '.res.stone, .warn.stone, .warn_90.stone, .res.mstone, .warn.mstone, .warn_90.mstone';
    var SEL_FERRO = '.res.iron, .warn.iron, .warn_90.iron, .res.miron, .warn.miron, .warn_90.miron';

    /*
     * O bloco da aldeia: `<tr>` no computador, cartão `<div>` no celular. Em vez de supor a
     * etiqueta, sobe na árvore até o primeiro antepassado que tenha os recursos DENTRO e apenas
     * UM nome de aldeia — a segunda condição é o que impede pegar a tabela inteira por engano.
     */
    function acharBloco(vn) {
        var el = vn.parentElement;
        for (var i = 0; i < 10 && el; i++) {
            if (el.querySelector(SEL_MADEIRA) && el.querySelectorAll('.quickedit-vn').length === 1) return el;
            el = el.parentElement;
        }
        return null;
    }

    // Todo o texto do bloco que vem DEPOIS do elemento do ferro (o último dos três recursos).
    function textoDepoisDe(bloco, el) {
        var partes = [], passou = false;
        var w = bloco.ownerDocument.createTreeWalker(bloco, 4 /* SHOW_TEXT */, null);
        var n;
        while ((n = w.nextNode())) {
            if (el.contains(n)) { passou = true; continue; }
            if (passou) partes.push(n.nodeValue);
        }
        return partes.join(' ');
    }

    // Quebra o texto em "números soltos" e "pares n/m", preservando a ordem em que aparecem.
    function fatiar(txt) {
        var toks = [], re = /(\d[\d.]*)\s*\/\s*(\d[\d.]*)|(\d[\d.]*)/g, m;
        while ((m = re.exec(txt))) {
            if (m[1] !== undefined) toks.push({ par: [limparNumero(m[1]), limparNumero(m[2])] });
            else toks.push({ num: limparNumero(m[3]) });
        }
        return toks;
    }

    function coletar(doc) {
        var nomes = [].slice.call(doc.querySelectorAll('.quickedit-vn'));
        aldeias = [];
        problemas = [];
        /*
         * Trava contra aldeia repetida. Se a página listar a mesma aldeia duas vezes (paginação
         * somada, marcação de dois layouts na mesma resposta), sairiam DOIS botões despachando da
         * MESMA origem — e o segundo mandaria recurso de novo. Aqui a segunda ocorrência é
         * descartada e contada, para aparecer no aviso em vez de passar batido.
         */
        var vistos = {};
        duplicadas = 0;

        nomes.forEach(function (vn) {
            var nome = String(vn.innerText || vn.textContent || '').trim();
            var falha = function (motivo) { problemas.push({ nome: nome || '(sem nome)', motivo: motivo }); };

            var bloco = acharBloco(vn);
            if (!bloco) return falha('não achei o bloco da aldeia');

            var elM = bloco.querySelector(SEL_MADEIRA);
            var elA = bloco.querySelector(SEL_ARGILA);
            var elF = bloco.querySelector(SEL_FERRO);
            if (!elM || !elA || !elF) return falha('não achei os recursos');

            var madeira = limparNumero(elM.textContent);
            var argila = limparNumero(elA.textContent);
            var ferro = limparNumero(elF.textContent);
            if (madeira === null || argila === null || ferro === null) return falha('recursos ilegíveis');

            /*
             * A ORDEM DOS CAMPOS MUDA ENTRE AS DUAS TELAS — conferido contra esta conta:
             *   computador: armazém, mercadores (n/m), fazenda (n/m)
             *   celular:    armazém, fazenda (n/m),   mercadores (número solto)
             *
             * Então quem decide não é a posição, é a CONTAGEM de pares: dois pares = computador
             * (o primeiro é mercador); um par só = celular (o par é fazenda, e o mercador é o
             * número solto seguinte). No celular o número é o DISPONÍVEL, não o total — medido
             * comparando as duas telas da mesma aldeia (83 e 95 contra total de 110).
             */
            var toks = fatiar(textoDepoisDe(bloco, elF));
            var iArm = -1;
            for (var i = 0; i < toks.length; i++) { if (toks[i].num != null) { iArm = i; break; } }
            if (iArm < 0) return falha('não achei a capacidade do armazém');
            var armazem = toks[iArm].num;
            if (!armazem || armazem < 1000) return falha('armazém com valor implausível (' + armazem + ')');

            var resto = toks.slice(iArm + 1);
            var pares = resto.filter(function (t) { return t.par; });
            var mercadores = null;
            if (pares.length >= 2) {
                mercadores = pares[0].par[0];                        // computador
            } else if (pares.length === 1) {
                var iPar = resto.indexOf(pares[0]);                  // celular
                for (var j = iPar + 1; j < resto.length; j++) {
                    if (resto[j].num != null) { mercadores = resto[j].num; break; }
                }
            }
            if (mercadores == null) return falha('não achei os mercadores');
            if (mercadores < 0 || mercadores > 100000) return falha('mercadores implausíveis (' + mercadores + ')');

            var coord = (nome.match(/(\d+)\|(\d+)/) || null);
            if (!coord) return falha('não achei a coordenada no nome');

            var id = vn.dataset ? vn.dataset.id : null;
            var chave = id || nome;
            if (vistos[chave]) { duplicadas++; return; }
            vistos[chave] = true;

            var link = vn.querySelector('a');
            aldeias.push({
                id: id,
                nome: nome,
                url: link ? link.href : null,
                x: parseInt(coord[1], 10),
                y: parseInt(coord[2], 10),
                madeira: madeira, argila: argila, ferro: ferro,
                armazem: armazem,
                mercadores: mercadores
            });
        });
        return aldeias.length;
    }

    // ---------- quanto mandar ----------
    /*
     * Reduz os três recursos pelo MESMO fator até caber no que os mercadores levam e no que sobra
     * na aldeia. Reduzir junto é o que mantém a proporção da moeda — se cada recurso fosse cortado
     * sozinho, o transporte chegaria desbalanceado e não fecharia moeda.
     */
    function quantoMandar(a, limitePct) {
        var carga = a.mercadores * CARGA_MERCADOR;
        var guardar = Math.floor(a.armazem / 100 * limitePct);
        var disp = {
            madeira: Math.max(0, a.madeira - guardar),
            argila: Math.max(0, a.argila - guardar),
            ferro: Math.max(0, a.ferro - guardar)
        };
        var env = {
            madeira: carga * PROP.madeira,
            argila: carga * PROP.argila,
            ferro: carga * PROP.ferro
        };
        ['madeira', 'argila', 'ferro'].forEach(function (k) {
            if (env[k] > disp[k]) {
                var f = env[k] === 0 ? 0 : disp[k] / env[k];
                env.madeira *= f; env.argila *= f; env.ferro *= f;
            }
        });
        return {
            madeira: Math.floor(env.madeira),
            argila: Math.floor(env.argila),
            ferro: Math.floor(env.ferro)
        };
    }

    // ---------- estilo ----------
    /*
     * Paleta do próprio jogo, igual à dos outros scripts da suíte (Simulador de Construção etc.):
     * pergaminho, borda marrom e cabeçalho em areia. Fica parecendo tela do TW em vez de painel
     * de fora.
     */
    var CSS = '<style id="cunhagem-css">' +
        '#cunhagem-painel{border:2px solid #7d510f;background:#f4e4bc;border-radius:6px;' +
        'margin:8px 0;padding:8px;font-size:12px;color:#2b1c00}' +
        '.cunhTab{border-collapse:collapse;width:100%}' +
        '.cunhTab td,.cunhTab th{padding:4px 8px;border-bottom:1px solid #d8c9a8}' +
        '.cunhH{background:#c1a264;font-weight:bold;color:#2b1c00;text-align:left}' +
        '.cunhA{background:#f4e4bc}.cunhB{background:#ece0c0}' +
        '.cunhErro{background:#f0c0c0;color:#7a1010}' +
        '.cunhLink{color:#603000;text-decoration:none;font-weight:bold}' +
        '.cunhLink:hover{text-decoration:underline}' +
        '.cunhTit{font-size:14px;font-weight:bold;color:#603000}' +
        '.cunhNum{text-align:right;font-variant-numeric:tabular-nums}' +
        /*
         * No celular a tabela é mais larga que a tela e o jogo não deixa arrastar de lado — daí a
         * necessidade de deitar o aparelho. A rolagem própria resolve, e a coluna Destino sai:
         * ela repete em toda linha o que já está escrito no topo, então é a primeira a sobrar.
         */
        '.cunhRolar{overflow-x:auto;-webkit-overflow-scrolling:touch}' +
        '@media (max-width:900px){' +
        '  #cunhagem-painel{padding:5px;font-size:11px}' +
        '  .cunhTab td,.cunhTab th{padding:3px 4px}' +
        '  .cunhDest{display:none}' +
        '  .cunhTab{min-width:420px}' +
        '}' +
        '</style>';

    // ---------- perguntar a coordenada ----------
    function pedirCoordenada() {
        var salva = '';
        try { salva = sessionStorage.getItem(CHAVE_COORD) || ''; } catch (e) { }
        var html = '<div style="max-width:520px">' +
            '<h2 class="popup_box_header" style="text-align:center">⚒️ Cunhagem APOSENTADOS</h2><hr>' +
            '<p style="text-align:center">Coordenada da aldeia que vai receber os recursos:</p>' +
            '<p style="text-align:center"><input type="text" id="cunh-coord" size="12" value="' + salva + '"></p>' +
            '<p style="text-align:center"><input type="button" class="btn btn-confirm-yes" id="cunh-ok" value="Continuar"></p>' +
            '<p style="text-align:center;font-size:11px;color:#666">Envia na proporção exata da moeda ' +
            '(' + fmt(CUSTO_MOEDA.madeira) + '/' + fmt(CUSTO_MOEDA.argila) + '/' + fmt(CUSTO_MOEDA.ferro) + ')</p>' +
            '</div>';
        Dialog.show('cunhagem', html);
        document.getElementById('cunh-ok').onclick = function () {
            var v = (document.getElementById('cunh-coord').value || '').match(/\d+\|\d+/);
            if (!v) { UI.ErrorMessage('Coordenada inválida. Use o formato 500|500.'); return; }
            try { sessionStorage.setItem(CHAVE_COORD, v[0]); } catch (e) { }
            var fechar = document.getElementsByClassName('popup_box_close');
            if (fechar[0]) fechar[0].click();
            buscarAlvo(v[0]);
        };
    }

    function buscarAlvo(coord) {
        var url = game_data.player.sitter > 0
            ? 'game.php?t=' + game_data.player.id + '&screen=api&ajax=target_selection&input=' + coord + '&type=coord'
            : '/game.php?screen=api&ajax=target_selection&input=' + coord + '&type=coord';
        $.get(url).done(function (json) {
            if (!json || !json.villages || !json.villages.length) {
                UI.ErrorMessage('Não achei aldeia em ' + coord + '.');
                return;
            }
            var v = json.villages[0];
            /*
             * `points` chega ora como número, ora como texto formatado ("6.720"), ora ausente —
             * depende da tela. Passar isso direto pro formatador imprimia "NaN pontos". Aqui vira
             * número de verdade, e quando não dá simplesmente não se mostra.
             */
            alvo = {
                id: v.id, nome: v.name, imagem: v.image, jogador: v.player_name,
                pontos: limparNumero(v.points),
                x: parseInt(v.x, 10), y: parseInt(v.y, 10)
            };
            prepararModo(montarLista);
        }).fail(function () {
            UI.ErrorMessage('Falhou ao consultar a coordenada ' + coord + '.');
        });
    }

    // ---------- PUXAR PARA ALDEIA SUA (Solicitar recursos) ----------
    /*
     * Quando o destino é uma aldeia SUA, o envio deixa de ser "um transporte por aldeia" e passa a
     * ser o "Solicitar recursos" do jogo (Mercado → Solicitar): UM pedido leva todas as aldeias.
     * Para outro jogador nada muda — o método antigo segue igual. (Pedido do dono, out/2026.)
     *
     * Medido ao vivo no br143 (01/10/2026), só lendo:
     *   - `screen=market&mode=call` lista TODAS as aldeias (`#village_list`, `tr.supply_location`
     *     com data-village = id e data-capacity = carga livre), já ORDENADAS pelo tempo de viagem
     *     ("Duração" H:MM:SS), com recursos, armazém e comerciantes "livres/total";
     *   - o botão do jogo NÃO recarrega a página: manda um `TribalWars.post` com
     *     `ajaxaction=call` e os campos `resource[ID][wood|stone|iron]` das aldeias marcadas, e a
     *     resposta traz `transport_info` com UMA entrada por aldeia que saiu — é com ela que cada
     *     linha é confirmada (a regra de sempre: só some da tela o que o servidor confirmou);
     *   - a página do Solicitar NÃO traz o que já está chegando no destino; isso vem da barra do
     *     Mercado (`#market_status_bar`, linha "Entrada:"), lida na aba de transportes.
     *
     * Armazém do DESTINO: NÃO limita nada — só mostra no somatório quanto ele fica ocupado (atual +
     * chegando + este envio). Decisão do dono ("não tem que ter limite, a opção é minha enviar"): na
     * cunhagem é normal chegar muito mais que o armazém, porque se cunha enquanto chega. No teste ao vivo
     * (0121, 01/10/2026) vinham 1,12M/1,20M/1,00M para um armazém de 400 mil, e um teto que existiu por
     * algumas horas cortou TODAS as 568 aldeias. Não reintroduzir.
     *
     * Se a leitura do Solicitar falhar, cai no método antigo (uma aldeia por vez) e avisa.
     */
    var puxar = null;   // { alvoId, linhas[], problemas[], entrada{}, destino{}, restante{}, soma{} }

    function modoPuxarAtivo() { return !!(puxar && alvo && puxar.alvoId === String(alvo.id)); }

    function urlJogo(params) {
        return (game_data.player.sitter > 0 ? 'game.php?t=' + game_data.player.id + '&' : '/game.php?') + params;
    }
    function htmlTemCaptcha(h) { return /bot_check|botprotection|hcaptcha/i.test(String(h || '')); }

    function lerSegundos(txt) {
        var m = String(txt || '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
    }
    function fmtDuracao(s) {
        s = Math.max(0, Math.round(s || 0));
        var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
        return h + ':' + (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
    }
    // Próprio (a versão da barra não tem o fmtRelogio do automático).
    function horaChegada(s) {
        try { return new Date(Date.now() + (s || 0) * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return '--:--'; }
    }

    // Uma página do Solicitar → linhas no MESMO formato de `aldeias` (+ segundos de viagem).
    function lerSolicitar(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var t = doc.getElementById('village_list');
        if (!t) return { erro: 'a página do Solicitar veio sem a lista de aldeias' };
        var linhas = [], probs = [];
        [].slice.call(t.querySelectorAll('tr')).forEach(function (tr) {
            var inM = tr.querySelector('input[name$="[wood]"]');
            var inA = tr.querySelector('input[name$="[stone]"]');
            var inF = tr.querySelector('input[name$="[iron]"]');
            if (!inM) return;                                           // cabeçalho
            var celulas = [].slice.call(tr.cells);
            var nome = String((celulas[0] && celulas[0].textContent) || '').replace(/\s+/g, ' ').trim();
            var falha = function (m) { probs.push({ nome: nome || '(sem nome)', motivo: m }); };
            if (!inA || !inF) return falha('recursos incompletos');
            var idm = String(inM.name || '').match(/resource\[(\d+)\]/);
            var id = tr.getAttribute('data-village') || (idm && idm[1]);
            if (!id) return falha('sem id da aldeia');
            var coords = nome.match(/\d+\|\d+/g);
            if (!coords) return falha('sem coordenada no nome');
            var xy = coords[coords.length - 1].split('|');
            var tdF = inF.closest('td');
            var madeira = limparNumero(inM.closest('td').textContent);
            var argila = limparNumero(inA.closest('td').textContent);
            var ferro = limparNumero(tdF.textContent);
            var iF = celulas.indexOf(tdF);
            var armazem = iF >= 0 && celulas[iF + 1] ? limparNumero(celulas[iF + 1].textContent) : null;
            var seg = null, merc = null;
            celulas.forEach(function (c) {
                if (seg === null) seg = lerSegundos(c.textContent);
                if (merc === null && c !== celulas[0]) merc = lerPar(c.textContent);
            });
            if (madeira === null || argila === null || ferro === null) return falha('recursos ilegíveis');
            if (seg === null) return falha('sem tempo de viagem');
            if (!armazem) return falha('sem armazém');
            var cap = parseInt(tr.getAttribute('data-capacity'), 10);
            var mercadores = isFinite(cap) ? Math.floor(cap / CARGA_MERCADOR) : (merc ? merc.usado : null);
            if (mercadores === null) return falha('sem comerciantes');
            linhas.push({ id: String(id), nome: nome, url: null, x: +xy[0], y: +xy[1],
                madeira: madeira, argila: argila, ferro: ferro, armazem: armazem, mercadores: mercadores, segundos: seg });
        });
        // Paginação ("Aldeias por página" baixo): busca as outras páginas também.
        var pags = {};
        [].slice.call(doc.querySelectorAll('a.paged-nav-item, .paged-nav-item a')).forEach(function (a) {
            var m = String(a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
            if (m) pags[m[1]] = true;
        });
        return { linhas: linhas, problemas: probs, paginas: Object.keys(pags) };
    }

    // "Entrada:" da barra do Mercado. Barra sem a linha = 0 de verdade; SEM a barra = não li (null).
    function lerEntrada(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var bar = doc.getElementById('market_status_bar');
        if (!bar) return null;
        var r = { madeira: 0, argila: 0, ferro: 0 };
        var th = [].slice.call(bar.querySelectorAll('th')).filter(function (t) { return /^\s*Entrada/i.test(t.textContent); })[0];
        if (!th) return r;
        [].slice.call(th.querySelectorAll('span.nowrap')).forEach(function (sp) {
            var ic = sp.querySelector('.icon'); var v = limparNumero(sp.textContent);
            if (!ic || v === null) return;
            if (ic.classList.contains('wood')) r.madeira = v;
            else if (ic.classList.contains('stone')) r.argila = v;
            else if (ic.classList.contains('iron')) r.ferro = v;
        });
        return r;
    }

    function carregarSolicitar(cb) {
        var base = 'village=' + alvo.id + '&screen=market';
        $.get(urlJogo(base + '&mode=call')).done(function (h1) {
            if (htmlTemCaptcha(h1)) return cb('o jogo pediu captcha', true);
            var r = lerSolicitar(h1);
            if (r.erro) return cb(r.erro);
            var vistos = {}; r.linhas.forEach(function (l) { vistos[l.id] = true; });
            var fila = r.paginas.slice();
            (function proxima() {
                if (fila.length) {
                    var p = fila.shift();
                    $.get(urlJogo(base + '&mode=call&page=' + p)).done(function (hp) {
                        if (htmlTemCaptcha(hp)) return cb('o jogo pediu captcha', true);
                        var rp = lerSolicitar(hp);
                        if (rp.erro) return cb(rp.erro);
                        rp.linhas.forEach(function (l) { if (!vistos[l.id]) { vistos[l.id] = true; r.linhas.push(l); } });
                        r.problemas = r.problemas.concat(rp.problemas);
                        proxima();
                    }).fail(function () { cb('falha ao abrir a página ' + p + ' do Solicitar'); });
                    return;
                }
                $.get(urlJogo(base + '&mode=transports')).done(function (h2) {
                    if (htmlTemCaptcha(h2)) return cb('o jogo pediu captcha', true);
                    var ent = lerEntrada(h2);
                    if (!ent) return cb('não consegui ler o que já está chegando no destino');
                    var dest = aldeias.filter(function (a) { return String(a.id) === String(alvo.id); })[0];
                    if (!dest) return cb('não achei o armazém do destino na visão de produção');
                    cb(null, false, {
                        alvoId: String(alvo.id), linhas: r.linhas, problemas: r.problemas, entrada: ent,
                        destino: { armazem: dest.armazem, madeira: dest.madeira, argila: dest.argila, ferro: dest.ferro }
                    });
                }).fail(function () { cb('falha ao ler o que está chegando no destino'); });
            })();
        }).fail(function () { cb('falha ao abrir o Solicitar recursos'); });
    }

    /*
     * Chamado depois de achar o alvo. Destino é aldeia sua (está na sua visão de produção) →
     * carrega o Solicitar; senão segue direto pro método de sempre.
     */
    function prepararModo(pronto) {
        puxar = null;
        var meu = aldeias.some(function (a) { return String(a.id) === String(alvo.id); });
        if (!meu) { pronto(); return; }
        carregarSolicitar(function (erro, captcha, dados) {
            if (erro && captcha) {
                // Captcha: não insiste e não cai pro método antigo (que bateria na mesma proteção).
                UI.ErrorMessage('O jogo pediu captcha ao abrir o Solicitar recursos. Resolva e abra de novo.');
                return;
            }
            if (erro) {
                UI.ErrorMessage('Destino é aldeia sua, mas ' + erro + '. Usando o envio normal (uma aldeia por vez).');
                pronto();
                return;
            }
            puxar = dados;
            pronto();
        });
    }

    function espacoNoDestino() {
        var d = puxar.destino, e = puxar.entrada;
        return {
            madeira: Math.max(0, d.armazem - d.madeira - e.madeira),
            argila: Math.max(0, d.armazem - d.argila - e.argila),
            ferro: Math.max(0, d.armazem - d.ferro - e.ferro)
        };
    }
    function iniciarContaDestino() {
        puxar.restante = espacoNoDestino();
        puxar.soma = { madeira: 0, argila: 0, ferro: 0, comerciantes: 0, aldeias: 0, ultima: 0 };
    }
    // Soma o envio da aldeia no somatório. Não corta nem reduz nada (ver o comentário do bloco).
    function caberNoDestino(q, a) {
        var r = puxar.restante;
        var tot = q.madeira + q.argila + q.ferro;
        r.madeira -= q.madeira; r.argila -= q.argila; r.ferro -= q.ferro;
        var s = puxar.soma;
        s.madeira += q.madeira; s.argila += q.argila; s.ferro += q.ferro;
        s.comerciantes += Math.ceil(tot / CARGA_MERCADOR);
        s.aldeias++;
        s.ultima = Math.max(s.ultima, a.segundos || 0);
        return q;
    }
    function moedasCom(m, a, f) {
        return Math.floor(Math.min(m / CUSTO_MOEDA.madeira, a / CUSTO_MOEDA.argila, f / CUSTO_MOEDA.ferro));
    }
    // Somatório do que vai sair agora (só no modo Solicitar).
    function resumoPuxar() {
        var s = puxar.soma, d = puxar.destino, e = puxar.entrada;
        var icone = function (r) { return '<span class="icon header ' + r + '"></span>'; };
        var pct = function (atual, chega, vai) { return Math.round((atual + chega + vai) / d.armazem * 100); };
        var noDestino = moedasCom(d.madeira + e.madeira + s.madeira, d.argila + e.argila + s.argila, d.ferro + e.ferro + s.ferro);
        return '<div id="cunh-resumo-puxar" style="margin:0 0 8px;padding:6px 8px;background:#e8f0d8;border:1px solid #9bb26b;border-radius:4px">' +
            '<b>📦 Vai sair agora:</b> ' + icone('wood') + ' <b>' + fmt(s.madeira) + '</b> &nbsp;' +
            icone('stone') + ' <b>' + fmt(s.argila) + '</b> &nbsp;' + icone('iron') + ' <b>' + fmt(s.ferro) + '</b>' +
            ' · ≈ <b>' + moedasCom(s.madeira, s.argila, s.ferro) + '</b> moeda(s)' +
            ' · <b>' + s.comerciantes + '</b> comerciante(s) · <b>' + s.aldeias + '</b> aldeia(s)' +
            (s.aldeias ? ' · o último chega às <b>' + horaChegada(s.ultima) + '</b> (' + fmtDuracao(s.ultima) + ')' : '') +
            '<br><span style="font-size:11px;color:#4a5a2a">🏠 Armazém do destino depois que tudo chegar (atual + já chegando + este envio): ' +
            icone('wood') + ' ' + pct(d.madeira, e.madeira, s.madeira) + '% &nbsp;' +
            icone('stone') + ' ' + pct(d.argila, e.argila, s.argila) + '% &nbsp;' +
            icone('iron') + ' ' + pct(d.ferro, e.ferro, s.ferro) + '% de ' + fmt(d.armazem) +
            ' · dá ≈ <b>' + noDestino + '</b> moeda(s) no total</span></div>';
    }
    function avisosPuxar(cortTempo, cortArm) {
        var h = '';
        if (puxar.problemas.length) {
            h += '<tr><td colspan="7" class="cunhErro">⚠️ ' + puxar.problemas.length +
                ' aldeia(s) ficaram DE FORA porque não consegui ler a linha delas no Solicitar: ' +
                puxar.problemas.slice(0, 5).map(function (p) { return p.nome + ' (' + p.motivo + ')'; }).join('; ') +
                (puxar.problemas.length > 5 ? ' …' : '') + '.</td></tr>';
        }
        if (cortTempo) {
            h += '<tr><td colspan="7" style="background:#ece0c0;color:#7a5c2e;padding:4px 6px">⏱ ' + cortTempo +
                ' aldeia(s) além de ' + tempoMaxAtual + ' h de viagem não aparecem.</td></tr>';
        }
        return h;
    }

    /*
     * Limite de TEMPO de viagem (horas). Só no modo Solicitar, que tem o tempo real de cada aldeia.
     * Mora numa variável pelo mesmo motivo da distância (o painel é remontado). Herda do automático
     * desta aba, se ligado.
     */
    var tempoMaxAtual = (function () {
        try {
            var c = JSON.parse(sessionStorage.getItem('cunh_auto_v1') || 'null');
            return (c && c.ligado && c.tempoMax) ? c.tempoMax : null;
        } catch (e) { return null; }
    })();
    function lerCampoTempo() {
        var el = document.getElementById('cunh-tempomax');
        if (!el) return tempoMaxAtual;
        var v = parseFloat(String(el.value).replace(',', '.'));
        tempoMaxAtual = (isFinite(v) && v > 0) ? v : null;
        return tempoMaxAtual;
    }

    /*
     * O envio pelo Solicitar, em BLOCOS.
     *
     * Primeira versão mandava TODAS num pedido só. No teste ao vivo do dono (01/10/2026), 517 aldeias
     * num pedido: o jogo processou uma parte e não respondeu em 15 s — e o script marcou as 517 como
     * falha, inclusive as que tinham saído (aí "Tentar de novo" mandaria de novo). Agora:
     *   - blocos de SOLICITAR_BLOCO aldeias, um de cada vez, com a pausa do lote entre eles;
     *   - cada aldeia é confirmada pela entrada dela em `transport_info`;
     *   - resposta que não veio (60 s), que veio com erro ou que não confirma alguma aldeia NÃO vira
     *     falha às cegas: o script RELÊ o Solicitar e confere quem teve os comerciantes reduzidos —
     *     esses saíram. Só fica vermelho o que de fato não saiu (ou o que não deu pra conferir);
     *   - "Parar" vale entre um bloco e outro.
     * aoTerminar(confirmadas, falhas, motivo).
     */
    var SOLICITAR_BLOCO = 25;
    var SOLICITAR_ESPERA_MS = 60000;

    function enviarPuxar(botoes, aoTerminar) {
        var itens = botoes.map(function (b) {
            var i = parseInt(b.getAttribute('data-i'), 10);
            return {
                b: b, i: i, l: puxar.linhas[i],
                q: { madeira: parseInt(b.getAttribute('data-m'), 10) || 0, argila: parseInt(b.getAttribute('data-a'), 10) || 0, ferro: parseInt(b.getAttribute('data-f'), 10) || 0 }
            };
        }).filter(function (x) { return x.l; });
        if (!itens.length) { if (aoTerminar) aoTerminar(0, 0, 'nada a enviar'); return; }
        itens.forEach(function (x) { x.b.disabled = true; x.b.value = 'Na fila…'; });

        var blocos = [];
        for (var k = 0; k < itens.length; k += SOLICITAR_BLOCO) blocos.push(itens.slice(k, k + SOLICITAR_BLOCO));
        var totOk = 0, totFal = 0, nb = 0;

        function pintarTotais() {
            var elM = document.getElementById('cunh-tm'), elA = document.getElementById('cunh-ta'), elF = document.getElementById('cunh-tf');
            if (elM) elM.textContent = fmt(enviado.madeira);
            if (elA) elA.textContent = fmt(enviado.argila);
            if (elF) elF.textContent = fmt(enviado.ferro);
        }
        function proximo() {
            if (!blocos.length) {
                if (typeof Dialog !== 'undefined' && Dialog.close) Dialog.close();
                if (totOk) UI.SuccessMessage(totOk + ' aldeia(s) enviada(s) pelo Solicitar' + (nb > 1 ? ' (' + nb + ' pedidos)' : '') + '.');
                if (totFal) UI.ErrorMessage(totFal + ' aldeia(s) não saíram — ficaram em vermelho na lista.');
                if (!document.querySelectorAll('#cunhagem-lista tr').length) UI.SuccessMessage('Acabou a fila de envios.');
                if (aoTerminar) aoTerminar(totOk, totFal, totFal ? 'algumas não saíram' : null);
                return;
            }
            // Parar (só no lote): devolve os que nem foram pedidos, sem marcar falha.
            if (lote.rodando && lote.parar) {
                blocos.forEach(function (bl) { bl.forEach(function (x) { x.b.disabled = false; x.b.value = 'Enviar recursos'; }); });
                blocos = [];
                if (aoTerminar) aoTerminar(totOk, totFal, 'parado por você');
                return;
            }
            var bloco = blocos.shift();
            nb++;
            if (lote.rodando) pintarLote('Pedido <b>' + nb + '</b> de ' + (nb + blocos.length) + ' (Solicitar, ' + bloco.length + ' aldeias) — ' + totOk + ' confirmada(s) até agora…');
            enviarBloco(bloco, function (ok, fal) {
                totOk += ok; totFal += fal;
                pintarTotais();
                if (blocos.length) setTimeout(proximo, pausaEscolhida()); else proximo();
            });
        }
        proximo();
    }

    function enviarBloco(itens, pronto) {
        var dados = { target_id: alvo.id };
        itens.forEach(function (x) {
            dados['resource[' + x.l.id + '][wood]'] = x.q.madeira;
            dados['resource[' + x.l.id + '][stone]'] = x.q.argila;
            dados['resource[' + x.l.id + '][iron]'] = x.q.ferro;
            x.b.value = 'Enviando…';
        });
        var acabou = false;
        function marcarFalha(x) {
            var tr = document.getElementById('cunh-linha-' + x.i);
            if (tr) tr.className = 'cunhErro';
            x.b.disabled = false; x.b.value = 'Tentar de novo';
            x.b.setAttribute('data-falhou', '1');
        }
        function registrarSucesso(x) {
            enviado.madeira += x.q.madeira; enviado.argila += x.q.argila; enviado.ferro += x.q.ferro;
            if (typeof somarNoTotalDaAba === 'function') somarNoTotalDaAba(x.q);
            x.l.madeira -= x.q.madeira; x.l.argila -= x.q.argila; x.l.ferro -= x.q.ferro;
            x.l.mercadores = Math.max(0, x.l.mercadores - Math.ceil((x.q.madeira + x.q.argila + x.q.ferro) / CARGA_MERCADOR));
            puxar.entrada.madeira += x.q.madeira; puxar.entrada.argila += x.q.argila; puxar.entrada.ferro += x.q.ferro;
            var tr = document.getElementById('cunh-linha-' + x.i);
            if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
        }
        // Fecha o bloco: confirmados pela resposta + (se precisar) conferidos relendo o Solicitar.
        function fechar(confirmados, motivo) {
            if (acabou) return;
            acabou = true;
            clearTimeout(relogio);
            var duvida = itens.filter(function (x) { return !confirmados[x.l.id]; });
            var ok = 0;
            itens.forEach(function (x) { if (confirmados[x.l.id]) { registrarSucesso(x); ok++; } });
            if (!duvida.length) { pronto(ok, 0); return; }
            duvida.forEach(function (x) { x.b.value = 'Conferindo…'; });
            conferirSaiu(duvida, function (saiu) {
                var fal = 0;
                duvida.forEach(function (x) {
                    if (saiu && saiu[x.l.id]) { registrarSucesso(x); ok++; } else { marcarFalha(x); fal++; }
                });
                if (fal) UI.ErrorMessage(fal + ' aldeia(s) não saíram' + (motivo ? ' (' + motivo + ')' : '') +
                    (saiu ? '' : ' — e não consegui reler o Solicitar para conferir: veja o mercado antes de repetir') + '.');
                pronto(ok, fal);
            });
        }
        var relogio = setTimeout(function () { fechar({}, 'o servidor não respondeu em ' + (SOLICITAR_ESPERA_MS / 1000) + ' s'); }, SOLICITAR_ESPERA_MS);
        TribalWars.post('market', { ajaxaction: 'call', village: alvo.id }, dados, function (resp) {
            var conf = {};
            if (resp && !resp.error && resp.success !== false && resp.transport_info && typeof resp.transport_info.length === 'number') {
                resp.transport_info.forEach(function (t) { if (t && t.village_id != null) conf[String(t.village_id)] = true; });
            }
            fechar(conf, resp && resp.error ? String(resp.error) : null);
        }, false);
    }

    /*
     * Confere quem SAIU relendo o Solicitar: a aldeia que tem MENOS comerciantes livres do que o
     * script tinha registrado mandou o transporte. saiu = { id: true } ou null se não deu pra ler.
     */
    function conferirSaiu(itens, cb) {
        var antes = {};
        itens.forEach(function (x) { antes[x.l.id] = x.l.mercadores; });
        var base = 'village=' + alvo.id + '&screen=market&mode=call';
        var agora = {}, fila = null;
        function ler(url, seguir) {
            $.get(urlJogo(url)).done(function (h) {
                if (htmlTemCaptcha(h)) { cb(null); return; }
                var r = lerSolicitar(h);
                if (r.erro) { cb(null); return; }
                r.linhas.forEach(function (l) { agora[l.id] = l.mercadores; });
                if (fila === null) fila = r.paginas.slice();
                seguir();
            }).fail(function () { cb(null); });
        }
        function passo() {
            if (fila && fila.length) { ler(base + '&page=' + fila.shift(), passo); return; }
            var saiu = {};
            Object.keys(antes).forEach(function (id) {
                if (agora[id] !== undefined && agora[id] < antes[id]) saiu[id] = true;
            });
            cb(saiu);
        }
        ler(base, passo);
    }

    // ---------- lista ----------
    function limite() {
        var v = 0;
        try { v = parseInt(sessionStorage.getItem(CHAVE_LIMITE) || '0', 10); } catch (e) { }
        return isFinite(v) && v >= 0 && v <= 100 ? v : 0;
    }

    /*
     * TRAVA DE DISTÂNCIA — o limite vive numa VARIÁVEL, não só no campo da tela.
     *
     * `montarLista()` começa apagando o painel inteiro, e o campo de distância vai junto. Se o
     * valor fosse lido do DOM lá dentro, ele já teria sumido — e o limite voltaria a "sem limite"
     * exatamente na hora de aplicá-lo. O campo é só a entrada; quem manda é isto aqui.
     */
    var distMaxAtual = null;

    function lerCampoDistancia() {
        var el = document.getElementById('cunh-distmax');
        if (!el) return distMaxAtual;
        var v = parseFloat(String(el.value).replace(',', '.'));
        distMaxAtual = (isFinite(v) && v > 0) ? v : null;   // vazio ou zero = sem limite
        return distMaxAtual;
    }

    function montarLista() {
        var antigo = document.getElementById('cunhagem-painel');
        if (antigo) antigo.parentNode.removeChild(antigo);

        var lim = limite();
        var cortadasPeloTempo = 0, cortadasPeloArmazem = 0;
        if (modoPuxarAtivo()) iniciarContaDestino();
        var linhas = '';
        var enviaveis = 0;
        var dmax = distMaxAtual;
        var cortadasPelaDistancia = 0;

        /*
         * ORDEM: da mais PERTO para a mais longe.
         *
         * A lista saía na ordem da visão de produção, que é a ordem das aldeias na conta — sem
         * relação com o que interessa aqui. Ordenar por distância põe em cima o transporte que
         * CHEGA ANTES, e é nessa ordem que o "Enviar tudo" despacha.
         *
         * O índice original (`i`) viaja junto: ele é a chave de `aldeias[i]` usada nos ids das
         * linhas e no `data-i` dos botões. Ordenar sem carregá-lo faria os botões apontarem para
         * a aldeia errada — e este é o código que move recurso.
         */
        var candidatas = [];
        (modoPuxarAtivo() ? puxar.linhas : aldeias).forEach(function (a, i) {
            if (String(a.id) === String(alvo.id)) return;          // não manda pra si mesma
            candidatas.push({ a: a, i: i, d: distancia(alvo.x, alvo.y, a.x, a.y), t: a.segundos });
        });
        // No Solicitar a ordem é a do TEMPO de viagem (o que chega antes), igual à tela do jogo.
        candidatas.sort(function (x, y) { return modoPuxarAtivo() ? ((x.t - y.t) || (x.d - y.d)) : x.d - y.d; });

        candidatas.forEach(function (item) {
            var a = item.a, i = item.i, d = item.d;
            // O corte vem ANTES de tudo: fora da lista, a aldeia sai também do "Enviar tudo".
            if (dmax !== null && d > dmax) { cortadasPelaDistancia++; return; }
            if (modoPuxarAtivo() && tempoMaxAtual !== null && a.segundos > tempoMaxAtual * 3600) { cortadasPeloTempo++; return; }
            var q = quantoMandar(a, lim);
            if (modoPuxarAtivo() && q.madeira + q.argila + q.ferro > 0) {
                q = caberNoDestino(q, a);
            }
            if (q.madeira + q.argila + q.ferro <= 0) return;
            enviaveis++;
            linhas += '<tr id="cunh-linha-' + i + '" class="' + (enviaveis % 2 ? 'cunhA' : 'cunhB') + '">' +
                '<td><a href="' + (a.url || '#') + '" class="cunhLink">' + a.nome + '</a></td>' +
                '<td class="cunhDest"><span class="cunhLink">' + alvo.nome + '</span></td>' +
                '<td style="text-align:center">' + d + (modoPuxarAtivo() ? '<br><span style="font-size:10px;color:#7a5c2e" title="tempo de viagem · chega às">⏱ ' + fmtDuracao(a.segundos) + ' · ' + horaChegada(a.segundos) + '</span>' : '') + '</td>' +
                '<td style="text-align:right">' + fmt(q.madeira) + ' <span class="icon header wood"></span></td>' +
                '<td style="text-align:right">' + fmt(q.argila) + ' <span class="icon header stone"></span></td>' +
                '<td style="text-align:right">' + fmt(q.ferro) + ' <span class="icon header iron"></span></td>' +
                '<td style="text-align:center">' +
                '<input type="button" class="btn btn-confirm-yes cunh-enviar" value="Enviar recursos" ' +
                'data-i="' + i + '" data-m="' + q.madeira + '" data-a="' + q.argila + '" data-f="' + q.ferro + '">' +
                '</td></tr>';
        });

        var avisoProblemas = modoPuxarAtivo() ? avisosPuxar(cortadasPeloTempo, cortadasPeloArmazem) : '';
        if (!modoPuxarAtivo() && problemas.length) {
            avisoProblemas += '<tr><td colspan="7" class="cunhErro">⚠️ ' + problemas.length +
                ' aldeia(s) ficaram DE FORA porque não consegui ler os dados: ' +
                problemas.slice(0, 5).map(function (p) { return p.nome + ' (' + p.motivo + ')'; }).join('; ') +
                (problemas.length > 5 ? ' …' : '') +
                '. Nenhum envio foi calculado para elas.</td></tr>';
        }
        if (!modoPuxarAtivo() && duplicadas) {
            avisoProblemas += '<tr><td colspan="7" class="cunhErro">⚠️ ' + duplicadas +
                ' aldeia(s) apareceram repetidas na listagem e a segunda cópia foi descartada. ' +
                'Sem isso haveria dois botões despachando da mesma origem.</td></tr>';
        }

        var topo =
            '<div class="cunhTit">⚒️ Cunhagem APOSENTADOS</div>' +
            (modoPuxarAtivo() ? '<div style="margin:2px 0;color:#2e5d1a;font-weight:bold">🏠 Destino é aldeia sua — envio pelo <u>Solicitar recursos</u>: poucos pedidos levam todas as aldeias (em blocos de 25), das que chegam antes para as de depois, com o somatório e a ocupação do armazém do destino.</div>' : '') +
            '<div style="margin:2px 0 8px;color:#603000">Destino: <b>' + alvo.nome + '</b> (' +
            alvo.x + '|' + alvo.y + ') · ' + alvo.jogador +
            (alvo.pontos ? ' · ' + fmt(alvo.pontos) + ' pontos' : '') + ' · ' +
            '<b>' + enviaveis + '</b> de ' + (modoPuxarAtivo() ? puxar.linhas.length : aldeias.length) + ' aldeia(s) com recurso a enviar</div>';

        var barra =
            '<div class="cunhRolar"><table class="cunhTab" style="margin-bottom:8px">' +
            '<tr><td class="cunhH">Enviar para</td><td class="cunhH">Manter no armazém</td>' +
            '<td class="cunhH" colspan="2">&nbsp;</td>' +
            '<td class="cunhH" colspan="3" style="text-align:right">Já enviado</td></tr>' +
            '<tr class="cunhA">' +
            '<td><input type="text" id="cunh-coord2" size="10" value="' + alvo.x + '|' + alvo.y + '"></td>' +
            '<td><input type="text" id="cunh-pct" size="2" value="' + lim + '"> %</td>' +
            '<td><button type="button" class="btn btn-confirm-yes" id="cunh-salvar">Salvar</button></td>' +
            '<td><button type="button" class="btn" id="cunh-recalc">Recalcular</button></td>' +
            '<td class="cunhNum"><span class="icon header wood"></span> <b id="cunh-tm">0</b></td>' +
            '<td class="cunhNum"><span class="icon header stone"></span> <b id="cunh-ta">0</b></td>' +
            '<td class="cunhNum"><span class="icon header iron"></span> <b id="cunh-tf">0</b></td>' +
            '</tr></table></div>' +
            // Flex com quebra: no celular os controles descem em linhas em vez de estourar a
            // largura. Nada aqui entra em container rolável — botão que exige rolar de lado para
            // ser alcançado é botão que não existe.
            '<div id="cunh-lote-barra" style="margin:0 0 8px;padding:6px;background:#ece0c0;' +
            'border-radius:4px;display:flex;flex-wrap:wrap;align-items:center;gap:6px">' +
            '<button type="button" class="btn btn-confirm-yes" id="cunh-tudo" ' +
            'style="font-weight:bold">Enviar tudo</button>' +
            '<button type="button" class="btn" id="cunh-parar" style="display:none">Parar</button>' +
            '<span title="Intervalo entre um envio e outro no Enviar tudo. Mínimo ' + PAUSA_PISO +
            ' ms. Fica guardado neste navegador.">pausa: <input type="text" id="cunh-pausa" size="4" value="' +
            pausaGuardada() + '"> ms</span>' +
            '<span style="font-size:11px;color:#5a4020" title="Cada Enter manda a PRÓXIMA aldeia da lista — um envio por tecla, ' +
            'igual ao clique. Segurar o Enter vai disparando em sequência, um de cada vez.">⏎ <b>Enter</b> envia a próxima</span>' +
            // O campo nasce com o limite EM USO, para o número não sumir da tela logo depois
            // de fazer efeito (a lista é remontada a cada aplicação).
            '<span title="Só aparecem aldeias até esta distância do destino. Vazio = sem limite.">' +
            'até <input type="text" id="cunh-distmax" size="4" value="' +
            (distMaxAtual === null ? '' : distMaxAtual) + '"> campos</span>' +
            (modoPuxarAtivo() ? '<span title="Só aldeias que chegam em até este tempo de viagem. Vazio = sem limite.">até <input type="text" id="cunh-tempomax" size="3" value="' + (tempoMaxAtual === null ? '' : tempoMaxAtual) + '"> h de viagem</span>' : '') +
            '<button type="button" class="btn" id="cunh-aplicar-dist">Aplicar</button>' +
            '<span id="cunh-status" style="color:#603000;flex:1 1 100%"></span>' +
            '</div>';

        var html = CSS +
            '<div id="cunhagem-painel">' + topo + (modoPuxarAtivo() ? resumoPuxar() : '') + barra +
            '<div class="cunhRolar"><table class="cunhTab">' +
            avisoProblemas +
            '<tr><th class="cunhH">Origem</th><th class="cunhH cunhDest">Destino</th>' +
            '<th class="cunhH" style="text-align:center">' + (modoPuxarAtivo() ? 'Dist. · tempo' : 'Dist.') + '</th>' +
            '<th class="cunhH" style="text-align:right">Madeira</th>' +
            '<th class="cunhH" style="text-align:right">Argila</th>' +
            '<th class="cunhH" style="text-align:right">Ferro</th>' +
            '<th class="cunhH" style="text-align:center">Ação</th></tr>' +
            '<tbody id="cunhagem-lista">' + linhas + '</tbody></table></div>' +
            (cortadasPelaDistancia ? '<div style="padding:4px 6px;margin-top:6px;font-size:11px;color:#7a5c2e">' +
                cortadasPelaDistancia + ' aldeia(s) fora do alcance de ' + dmax + ' campos não aparecem.</div>' : '') +
            (enviaveis ? '' : '<div class="cunhErro" style="padding:6px;margin-top:6px">Nenhuma aldeia ' +
                'tem recurso disponível acima do limite escolhido.</div>') +
            '</div>';

        var onde = document.getElementById('contentContainer') || document.getElementById('mobileHeader');
        if (!onde) { UI.ErrorMessage('Não achei onde encaixar o painel.'); return; }
        var div = document.createElement('div');
        div.innerHTML = html;
        onde.insertBefore(div, onde.firstChild);

        function guardarPct() {
            var v = parseInt(document.getElementById('cunh-pct').value, 10);
            if (!isFinite(v) || v < 0 || v > 100) { UI.ErrorMessage('Use um número de 0 a 100.'); return false; }
            try { sessionStorage.setItem(CHAVE_LIMITE, String(v)); } catch (e) { }
            return true;
        }
        document.getElementById('cunh-recalc').onclick = function () {
            if (guardarPct()) montarLista();
        };
        // "Salvar" guarda o limite E troca o alvo, se a coordenada tiver mudado.
        document.getElementById('cunh-salvar').onclick = function () {
            if (!guardarPct()) return;
            var c = (document.getElementById('cunh-coord2').value || '').match(/\d+\|\d+/);
            if (!c) { UI.ErrorMessage('Coordenada inválida. Use o formato 500|500.'); return; }
            try { sessionStorage.setItem(CHAVE_COORD, c[0]); } catch (e) { }
            if (c[0] === alvo.x + '|' + alvo.y) { montarLista(); return; }
            buscarAlvo(c[0]);
        };

        // Um ouvinte só, delegado: as linhas somem conforme os envios confirmam.
        document.getElementById('cunhagem-lista').addEventListener('click', function (ev) {
            var b = ev.target;
            if (!b || !b.classList || !b.classList.contains('cunh-enviar')) return;
            // Clique manual durante o lote confundiria a contagem e mandaria dois ao mesmo tempo.
            if (lote.rodando) { UI.ErrorMessage('O lote está rodando. Pare antes de enviar à mão.'); return; }
            b.removeAttribute('data-falhou');      // tentativa manual limpa a marca de falha
            enviar(b);
        });

        document.getElementById('cunh-tudo').onclick = confirmarLote;

        // Pausa: guarda assim que muda (e corrige o campo se ficou abaixo do piso).
        var cpPausa = document.getElementById('cunh-pausa');
        if (cpPausa) cpPausa.onchange = function () { pausaEscolhida(); };

        ligarEnter();

        var btDist = document.getElementById('cunh-aplicar-dist');
        if (btDist) btDist.onclick = function () {
            lerCampoTempo();                     // tempo de viagem (só no Solicitar)
            lerCampoDistancia();      // do campo para a variável, ANTES de remontar a lista
            montarLista();
        };
        document.getElementById('cunh-parar').onclick = function () {
            lote.parar = true;
            pintarLote('Parando depois do envio em curso…');
        };
    }

    // ---------- Enter = envia a próxima (como no script do Shinko to Kuma) ----------
    /*
     * Cada Enter manda a PRÓXIMA aldeia pendente da lista: um envio por tecla, exatamente o que o
     * clique no botão faz. Segurar o Enter vai disparando em sequência.
     *
     * Regras, cada uma com motivo:
     *   - UM envio por vez: enquanto o anterior não responde, Enter é ignorado. A repetição da
     *     tecla (~30 por segundo) dispararia vários pedidos juntos — a mesma rajada que a pausa do
     *     lote existe pra evitar, e o jogo começa a recusar.
     *   - Pula o que falhou (mesma fila do "Enviar tudo": `botoesPendentes` já tira os
     *     `data-falhou`), senão o Enter ficaria batendo na mesma aldeia quebrada.
     *   - Enter DIGITANDO num campo (coordenada, pausa, distância) é do campo, não envia nada.
     *   - Com o lote rodando, não envia (contaria em dobro e mandaria dois ao mesmo tempo).
     *   - Com janela aberta (a confirmação do "Enviar tudo"), o Enter é dela.
     *   - `preventDefault`: sem ele, o Enter também "clica" no botão que estiver com foco — o
     *     mesmo envio sairia duas vezes.
     * Um ouvinte só, no documento: o painel é remontado a cada envio/aplicar.
     */
    var enviandoPorEnter = false;
    function ligarEnter() {
        if (window.__cunhEnterLigado) return;
        window.__cunhEnterLigado = true;
        document.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
            if (ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
            if (!document.getElementById('cunhagem-lista')) return;          // painel fechado
            if (document.getElementById('cunh-lote-sim') || document.querySelector('.popup_box_container')) return;
            var t = ev.target;
            var tipo = t && t.type ? String(t.type).toLowerCase() : '';
            if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
                (t.tagName === 'INPUT' && tipo !== 'button' && tipo !== 'submit' && tipo !== 'checkbox'))) return;
            ev.preventDefault();
            if (lote.rodando || enviandoPorEnter) return;
            var prox = botoesPendentes()[0];
            if (!prox) { UI.InfoMessage ? UI.InfoMessage('Nada pendente na lista.') : null; return; }
            enviandoPorEnter = true;
            enviar(prox, function () { enviandoPorEnter = false; });
        });
    }

    // ---------- envio ----------
    function enviar(botao, aoTerminar) {
        if (modoPuxarAtivo()) {
            enviarPuxar([botao], function (ok, falhas, motivo) { if (aoTerminar) aoTerminar(ok > 0 && !falhas, motivo); });
            return;
        }
        var i = botao.getAttribute('data-i');
        var a = aldeias[parseInt(i, 10)];
        var q = {
            madeira: parseInt(botao.getAttribute('data-m'), 10),
            argila: parseInt(botao.getAttribute('data-a'), 10),
            ferro: parseInt(botao.getAttribute('data-f'), 10)
        };
        botao.disabled = true;
        botao.value = 'Enviando…';

        var respondeu = false;
        function falhou(motivo) {
            if (respondeu) return;
            respondeu = true;
            // Falha fica VISÍVEL: linha vermelha, botão liberado, nada some da tela.
            var tr = document.getElementById('cunh-linha-' + i);
            if (tr) tr.className = 'cunhErro';
            botao.disabled = false;
            botao.value = 'Tentar de novo';
            // Marca para o lote NÃO reeleger esta linha: como a falha devolve o botão, sem esta
            // marca o "Enviar tudo" escolheria a mesma aldeia para sempre.
            botao.setAttribute('data-falhou', '1');
            UI.ErrorMessage('Não confirmei o envio de ' + a.nome + ': ' + motivo);
            if (aoTerminar) aoTerminar(false, motivo);
        }

        /*
         * O silêncio é tratado como falha. `TribalWars.post` avisa por CALLBACK, e a 5ª posição da
         * chamada recebe um booleano — não há garantia de que ali caiba um callback de erro, então
         * a confirmação NÃO depende disso: há um relógio próprio. Se em 12 s não vier resposta, a
         * linha continua na tela, em vermelho.
         *
         * Apagar a linha por tempo (uns 200 ms após o clique) seria o erro a evitar: envio recusado
         * sumiria da tela igual a um que deu certo.
         */
        var relogio = setTimeout(function () {
            falhou('o servidor não respondeu em 12 s. Confira a aldeia antes de repetir — ' +
                'pode ter saído mesmo assim.');
        }, 12000);

        TribalWars.post('market',
            { ajaxaction: 'map_send', village: a.id },
            { target_id: alvo.id, wood: q.madeira, stone: q.argila, iron: q.ferro },
            function (resp) {
                clearTimeout(relogio);
                if (respondeu) return;
                // Resposta que veio, mas negando: também é falha.
                if (resp && (resp.error || resp.success === false)) {
                    falhou(String(resp.error || 'o jogo recusou o envio'));
                    return;
                }
                respondeu = true;
                if (typeof Dialog !== 'undefined' && Dialog.close) Dialog.close();
                UI.SuccessMessage((resp && resp.message) || 'Enviado.');
                enviado.madeira += q.madeira; enviado.argila += q.argila; enviado.ferro += q.ferro;
                /*
                 * Com guarda porque o painel pode ter sumido entre o clique e a resposta — o app
                 * do celular refaz a tela sozinho, e navegar durante o lote tem o mesmo efeito.
                 * Sem isso, um TypeError aqui dentro engoliria o aviso de conclusão e o lote
                 * ficaria pendurado em "Enviando…" para sempre.
                 */
                var elM = document.getElementById('cunh-tm');
                var elA = document.getElementById('cunh-ta');
                var elF = document.getElementById('cunh-tf');
                if (elM) elM.textContent = fmt(enviado.madeira);
                if (elA) elA.textContent = fmt(enviado.argila);
                if (elF) elF.textContent = fmt(enviado.ferro);
                var tr = document.getElementById('cunh-linha-' + i);
                if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
                if (!document.querySelectorAll('#cunhagem-lista tr').length) {
                    UI.SuccessMessage('Acabou a fila de envios.');
                }
                if (aoTerminar) aoTerminar(true, null);
            },
            false                                   // assinatura conhecida do jogo; não invento outra
        );
    }

    // ---------- envio em lote ----------
    /*
     * Despacha as aldeias uma de cada vez, nunca em paralelo.
     *
     * O intervalo entre envios existe para não martelar o servidor com dezenas de requisições em
     * rajada. É uma pausa honesta e visível, ajustável na tela — não é disfarce: o lote continua
     * sendo exatamente a mesma sequência de cliques que você faria à mão, só que sozinha.
     *
     * Três freios, porque isto move recurso e não tem desfazer:
     *   - uma confirmação única, mostrando o total exato antes de começar;
     *   - botão Parar, que interrompe depois do envio em curso;
     *   - parada automática em 3 falhas seguidas, para não insistir contra um problema real.
     */
    var lote = { rodando: false, parar: false, ok: 0, falhas: 0, seguidas: 0 };
    var PAUSA_PADRAO = 1500;
    /*
     * Piso da pausa. Abaixo dele, o valor digitado vira o PISO — não volta pro padrão.
     *
     * Antes, qualquer coisa abaixo de 300 caía calada em 1.500: quem digitava 200 achando que ia
     * acelerar ficava com o lote SETE vezes mais lento, sem aviso, e a sensação era "não consigo
     * baixar de 1.500". 200 ms = 5 envios por segundo, o ritmo que o jogo aguenta sem reclamar.
     */
    var PAUSA_PISO = 200;
    var CHAVE_PAUSA = 'cunhagem_pausa_ms';

    function normalizarPausa(v) {
        v = parseInt(v, 10);
        if (!isFinite(v)) return PAUSA_PADRAO;
        return Math.min(Math.max(v, PAUSA_PISO), 60000);
    }
    // A pausa escolhida fica guardada (antes voltava pra 1.500 toda vez que o painel abria).
    function pausaGuardada() {
        try { var s = localStorage.getItem(CHAVE_PAUSA); if (s !== null) return normalizarPausa(s); } catch (e) { }
        return PAUSA_PADRAO;
    }

    function pausaEscolhida() {
        var el = document.getElementById('cunh-pausa');
        var v = normalizarPausa(el ? el.value : NaN);
        // Mostra no campo o valor que vai valer de fato (ex.: digitou 50 → fica 200).
        if (el && String(v) !== String(el.value).trim()) el.value = String(v);
        try { localStorage.setItem(CHAVE_PAUSA, String(v)); } catch (e) { }
        return v;
    }

    function botoesPendentes() {
        return [].slice.call(
            document.querySelectorAll('#cunhagem-lista .cunh-enviar:not([disabled]):not([data-falhou])'));
    }

    function pintarLote(txt) {
        var el = document.getElementById('cunh-status');
        if (el) el.innerHTML = txt;
    }

    function terminarLote(motivo) {
        lote.rodando = false;
        var b = document.getElementById('cunh-tudo');
        if (b) { b.disabled = false; b.textContent = 'Enviar tudo'; }
        var p = document.getElementById('cunh-parar');
        if (p) p.style.display = 'none';
        pintarLote('<b>Lote encerrado</b> (' + motivo + ') — ' + lote.ok + ' enviada(s)' +
            (lote.falhas ? ', <span style="color:#a00">' + lote.falhas + ' sem confirmação</span>' : '') + '.');
    }

    function passoDoLote() {
        if (!lote.rodando) return;
        if (lote.parar) { terminarLote('parado por você'); return; }
        // Painel sumiu (tela refeita pelo app, navegação): encerra em vez de seguir no escuro.
        if (!document.getElementById('cunhagem-lista')) {
            lote.rodando = false;
            UI.ErrorMessage('O painel saiu da tela e o lote parou. Foram ' + lote.ok +
                ' envio(s) confirmado(s) antes disso.');
            return;
        }
        var restantes = botoesPendentes();
        if (!restantes.length) { terminarLote('fila vazia'); return; }
        if (modoPuxarAtivo()) {
            pintarLote('Enviando <b>' + restantes.length + '</b> aldeia(s) pelo Solicitar recursos, em blocos…');
            enviarPuxar(restantes, function (ok, fal) {
                lote.ok += ok; lote.falhas += fal;
                terminarLote(fal ? 'Solicitar, com aldeias que não saíram' : 'Solicitar');
            });
            return;
        }
        var total = lote.ok + lote.falhas + restantes.length;
        pintarLote('Enviando <b>' + (lote.ok + lote.falhas + 1) + ' de ' + total + '</b>…');
        enviar(restantes[0], function (deuCerto) {
            if (deuCerto) { lote.ok++; lote.seguidas = 0; }
            else { lote.falhas++; lote.seguidas++; }
            if (lote.seguidas >= 3) {
                terminarLote('3 falhas seguidas — parei para você conferir');
                return;
            }
            setTimeout(passoDoLote, pausaEscolhida());
        });
    }

    function confirmarLote() {
        var pend = botoesPendentes();
        if (!pend.length) { UI.ErrorMessage('Não há envio pendente.'); return; }
        var t = { m: 0, a: 0, f: 0 };
        pend.forEach(function (b) {
            t.m += parseInt(b.getAttribute('data-m'), 10) || 0;
            t.a += parseInt(b.getAttribute('data-a'), 10) || 0;
            t.f += parseInt(b.getAttribute('data-f'), 10) || 0;
        });
        // Confirmação pela janela do jogo, nunca por `confirm()`: o nativo trava a página inteira.
        Dialog.show('cunhagem-lote',
            '<div style="max-width:520px">' +
            '<h2 class="popup_box_header" style="text-align:center">Enviar tudo?</h2><hr>' +
            '<p style="text-align:center">Vão sair <b>' + pend.length + '</b> transportes para<br>' +
            '<b>' + alvo.nome + '</b> (' + alvo.x + '|' + alvo.y + ')</p>' +
            '<p style="text-align:center;font-size:14px">' +
            '<span class="icon header wood"></span> <b>' + fmt(t.m) + '</b> &nbsp; ' +
            '<span class="icon header stone"></span> <b>' + fmt(t.a) + '</b> &nbsp; ' +
            '<span class="icon header iron"></span> <b>' + fmt(t.f) + '</b></p>' +
            '<p style="text-align:center;color:#666;font-size:11px">' + (modoPuxarAtivo()
                ? 'Pelo Solicitar recursos, em pedidos de ' + SOLICITAR_BLOCO + ' aldeias. Dá para parar no meio.<br>'
                : 'Um de cada vez, com pausa de ' + (pausaEscolhida() / 1000).toFixed(1) + ' s. Dá para parar no meio.<br>') +
            'Recurso enviado não volta.</p>' +
            '<p style="text-align:center">' +
            '<input type="button" class="btn btn-confirm-yes" id="cunh-lote-sim" value="Enviar os ' +
            pend.length + '"> &nbsp; ' +
            '<input type="button" class="btn" id="cunh-lote-nao" value="Cancelar"></p></div>');

        document.getElementById('cunh-lote-nao').onclick = function () {
            var f = document.getElementsByClassName('popup_box_close');
            if (f[0]) f[0].click();
        };
        document.getElementById('cunh-lote-sim').onclick = function () {
            var f = document.getElementsByClassName('popup_box_close');
            if (f[0]) f[0].click();
            lote = { rodando: true, parar: false, ok: 0, falhas: 0, seguidas: 0 };
            var b = document.getElementById('cunh-tudo');
            if (b) { b.disabled = true; b.textContent = 'Enviando…'; }
            var p = document.getElementById('cunh-parar');
            if (p) p.style.display = '';
            passoDoLote();
        };
    }

    // ---------- carregar a lista e começar ----------
    function comecar(botao) {
        if (botao) { botao.disabled = true; botao.textContent = 'Lendo suas aldeias…'; }
        function devolverBotao() {
            if (botao) { botao.disabled = false; botao.innerHTML = ROTULO_BOTAO; }
        }
        var urlLista = game_data.player.sitter > 0
            ? 'game.php?t=' + game_data.player.id + '&screen=overview_villages&mode=prod&page=-1'
            : 'game.php?screen=overview_villages&mode=prod&page=-1';

        $.get(urlLista).done(function (pagina) {
            devolverBotao();
            var doc = new DOMParser().parseFromString(pagina, 'text/html');
            var n = coletar(doc);
            if (!n) {
                UI.ErrorMessage('Não consegui ler nenhuma aldeia da visão de produção.' +
                    (problemas.length ? ' Problemas: ' + problemas[0].motivo : ''));
                return;
            }
            // Só agora pergunta a coordenada: se as duas coisas correrem juntas, responder rápido
            // monta a lista vazia.
            pedirCoordenada();
        }).fail(function () {
            devolverBotao();
            UI.ErrorMessage('Falhou ao carregar a visão de produção das aldeias.');
        });
    }

    // ---------- entrada ----------
    /*
     * Duas portas de entrada, porque há dois jeitos de usar:
     *
     *   Academia (screen=snob) — o script é injetado pelo gerenciador em toda visita à tela, e
     *   sair varrendo 100+ aldeias sem ninguém pedir seria abuso. Aqui ele só planta o botão.
     *
     *   Qualquer outro lugar — veio de favorito/barra, ou seja, foi chamado de propósito: roda
     *   direto, sem passo a mais.
     *
     * O `id` do botão é o que o gerenciador usa como `initElement` para saber que já carregou.
     */
    var ROTULO_BOTAO = '<span class="icon header wood"></span>' +
        '<span class="icon header stone"></span>' +
        '<span class="icon header iron"></span> Cunhagem APOSENTADOS';

    function plantarBotao() {
        if (document.getElementById('cunh-btn')) return;
        var alvo = document.getElementById('content_value') ||
            document.getElementById('contentContainer') ||
            document.getElementById('mobileHeader');
        if (!alvo) return;
        var cx = document.createElement('div');
        cx.style.cssText = 'margin:8px 0;text-align:center';
        var b = document.createElement('button');
        b.id = 'cunh-btn';
        b.type = 'button';
        b.className = 'btn btn-confirm-yes';
        b.style.cssText = 'font-size:14px;font-weight:bold;padding:8px 16px;cursor:pointer';
        b.innerHTML = ROTULO_BOTAO;
        b.onclick = function () { comecar(b); };
        cx.appendChild(b);
        alvo.insertBefore(cx, alvo.firstChild);
    }

    if (/screen=snob/.test(location.href)) plantarBotao();
    else comecar(null);
})();
