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
 * 5. Distância separa a coordenada no "|" em vez de fatiar por posição fixa — coordenada de 2
 *    dígitos quebraria o corte por índice.
 */
(function () {
    'use strict';

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
            montarLista();
        }).fail(function () {
            UI.ErrorMessage('Falhou ao consultar a coordenada ' + coord + '.');
        });
    }

    // ---------- lista ----------
    function limite() {
        var v = 0;
        try { v = parseInt(sessionStorage.getItem(CHAVE_LIMITE) || '0', 10); } catch (e) { }
        return isFinite(v) && v >= 0 && v <= 100 ? v : 0;
    }

    function montarLista() {
        var antigo = document.getElementById('cunhagem-painel');
        if (antigo) antigo.parentNode.removeChild(antigo);

        var lim = limite();
        var linhas = '';
        var enviaveis = 0;

        aldeias.forEach(function (a, i) {
            if (String(a.id) === String(alvo.id)) return;          // não manda pra si mesma
            var q = quantoMandar(a, lim);
            if (q.madeira + q.argila + q.ferro <= 0) return;
            enviaveis++;
            linhas += '<tr id="cunh-linha-' + i + '" class="' + (i % 2 ? 'cunhA' : 'cunhB') + '">' +
                '<td><a href="' + (a.url || '#') + '" class="cunhLink">' + a.nome + '</a></td>' +
                '<td class="cunhDest"><span class="cunhLink">' + alvo.nome + '</span></td>' +
                '<td style="text-align:center">' + distancia(alvo.x, alvo.y, a.x, a.y) + '</td>' +
                '<td style="text-align:right">' + fmt(q.madeira) + ' <span class="icon header wood"></span></td>' +
                '<td style="text-align:right">' + fmt(q.argila) + ' <span class="icon header stone"></span></td>' +
                '<td style="text-align:right">' + fmt(q.ferro) + ' <span class="icon header iron"></span></td>' +
                '<td style="text-align:center">' +
                '<input type="button" class="btn btn-confirm-yes cunh-enviar" value="Enviar recursos" ' +
                'data-i="' + i + '" data-m="' + q.madeira + '" data-a="' + q.argila + '" data-f="' + q.ferro + '">' +
                '</td></tr>';
        });

        var avisoProblemas = '';
        if (problemas.length) {
            avisoProblemas += '<tr><td colspan="7" class="cunhErro">⚠️ ' + problemas.length +
                ' aldeia(s) ficaram DE FORA porque não consegui ler os dados: ' +
                problemas.slice(0, 5).map(function (p) { return p.nome + ' (' + p.motivo + ')'; }).join('; ') +
                (problemas.length > 5 ? ' …' : '') +
                '. Nenhum envio foi calculado para elas.</td></tr>';
        }
        if (duplicadas) {
            avisoProblemas += '<tr><td colspan="7" class="cunhErro">⚠️ ' + duplicadas +
                ' aldeia(s) apareceram repetidas na listagem e a segunda cópia foi descartada. ' +
                'Sem isso haveria dois botões despachando da mesma origem.</td></tr>';
        }

        var topo =
            '<div class="cunhTit">⚒️ Cunhagem APOSENTADOS</div>' +
            '<div style="margin:2px 0 8px;color:#603000">Destino: <b>' + alvo.nome + '</b> (' +
            alvo.x + '|' + alvo.y + ') · ' + alvo.jogador +
            (alvo.pontos ? ' · ' + fmt(alvo.pontos) + ' pontos' : '') + ' · ' +
            '<b>' + enviaveis + '</b> de ' + aldeias.length + ' aldeia(s) com recurso a enviar</div>';

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
            '<div style="margin:0 0 8px;padding:6px;background:#ece0c0;border-radius:4px">' +
            '<button type="button" class="btn btn-confirm-yes" id="cunh-tudo" ' +
            'style="font-weight:bold">Enviar tudo</button> ' +
            '<button type="button" class="btn" id="cunh-parar" style="display:none">Parar</button> ' +
            '<span style="margin-left:8px">pausa entre envios: ' +
            '<input type="text" id="cunh-pausa" size="4" value="' + PAUSA_PADRAO + '"> ms</span> ' +
            '<span id="cunh-status" style="margin-left:10px;color:#603000"></span>' +
            '</div>';

        var html = CSS +
            '<div id="cunhagem-painel">' + topo + barra +
            '<div class="cunhRolar"><table class="cunhTab">' +
            avisoProblemas +
            '<tr><th class="cunhH">Origem</th><th class="cunhH cunhDest">Destino</th>' +
            '<th class="cunhH" style="text-align:center">Dist.</th>' +
            '<th class="cunhH" style="text-align:right">Madeira</th>' +
            '<th class="cunhH" style="text-align:right">Argila</th>' +
            '<th class="cunhH" style="text-align:right">Ferro</th>' +
            '<th class="cunhH" style="text-align:center">Ação</th></tr>' +
            '<tbody id="cunhagem-lista">' + linhas + '</tbody></table></div>' +
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
        document.getElementById('cunh-parar').onclick = function () {
            lote.parar = true;
            pintarLote('Parando depois do envio em curso…');
        };
    }

    // ---------- envio ----------
    function enviar(botao, aoTerminar) {
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
                document.getElementById('cunh-tm').textContent = fmt(enviado.madeira);
                document.getElementById('cunh-ta').textContent = fmt(enviado.argila);
                document.getElementById('cunh-tf').textContent = fmt(enviado.ferro);
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

    function pausaEscolhida() {
        var el = document.getElementById('cunh-pausa');
        var v = el ? parseInt(el.value, 10) : NaN;
        if (!isFinite(v) || v < 300) return PAUSA_PADRAO;      // piso: rajada não ajuda ninguém
        return Math.min(v, 60000);
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
        var restantes = botoesPendentes();
        if (!restantes.length) { terminarLote('fila vazia'); return; }
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
            '<p style="text-align:center;color:#666;font-size:11px">Um de cada vez, com pausa de ' +
            (pausaEscolhida() / 1000).toFixed(1) + ' s. Dá para parar no meio.<br>' +
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
