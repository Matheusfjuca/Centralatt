/*
 * Enviar recursos para cunhagem de moedas
 * ---------------------------------------
 * Baseado no script de Sophie "Shinko to Kuma" (https://shinko-to-kuma.my-free.website/).
 * Correções e reescrita da coleta de dados por conta desta revisão — o crédito da ideia e da
 * lógica de proporção é dela.
 *
 * O QUE MUDOU EM RELAÇÃO AO ORIGINAL
 * ----------------------------------
 * 1. A pergunta da coordenada só aparece DEPOIS que a lista de aldeias chegou. No original ela era
 *    disparada em paralelo com a busca, e responder rápido demais montava a lista vazia — sem erro
 *    na tela.
 *
 * 2. A linha só some quando o servidor CONFIRMA o envio. O original removia a linha 200 ms depois
 *    do clique, sem esperar resposta: envio que falhava sumia da tela igualzinho a um que deu
 *    certo, e os totais não subiam. Era o defeito mais perigoso, porque falhava em silêncio.
 *
 * 3. Uma coleta só, sem ramo separado para celular. O ramo mobile do original empilhava TODOS os
 *    mercadores para CADA aldeia (laço dentro de laço), então a aldeia i lia o mercador errado, e
 *    o total de mercadores era o literal "999". Aqui a leitura é por posição relativa dentro da
 *    linha da aldeia, o que funciona nos dois layouts.
 *
 * 4. Aldeia cujos dados não foram lidos por completo NÃO entra na lista de envio, e aparece num
 *    aviso. Script que manda recurso não pode chutar: mandar errado não tem desfazer.
 *
 * 5. Distância calculada separando a coordenada no "|", em vez de fatiar por posição fixa
 *    (`substring(0,3)`), que devolvia NaN em coordenada de 2 dígitos.
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

            var link = vn.querySelector('a');
            aldeias.push({
                id: vn.dataset ? vn.dataset.id : null,
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
    var CSS = '<style id="cunhagem-css">' +
        '.cunhA{background:#32353b;color:#fff}.cunhB{background:#36393f;color:#fff}' +
        '.cunhH{background:#202225;font-weight:bold;color:#fff}' +
        '.cunhErro{background:#5a2020;color:#fff}' +
        '#cunhagem-lista td{padding:3px 5px}' +
        '</style>';

    // ---------- perguntar a coordenada ----------
    function pedirCoordenada() {
        var salva = '';
        try { salva = sessionStorage.getItem(CHAVE_COORD) || ''; } catch (e) { }
        var html = '<div style="max-width:520px">' +
            '<h2 class="popup_box_header" style="text-align:center">Enviar recursos para cunhagem</h2><hr>' +
            '<p style="text-align:center">Coordenada da aldeia que vai receber:</p>' +
            '<p style="text-align:center"><input type="text" id="cunh-coord" size="12" value="' + salva + '"></p>' +
            '<p style="text-align:center"><input type="button" class="btn btn-confirm-yes" id="cunh-ok" value="Continuar"></p>' +
            '<p style="text-align:center;font-size:11px">Baseado no script de ' +
            '<a href="https://shinko-to-kuma.my-free.website/" target="_blank">Sophie "Shinko to Kuma"</a></p>' +
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
            alvo = { id: v.id, nome: v.name, imagem: v.image, jogador: v.player_name, pontos: v.points, x: v.x, y: v.y };
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
                '<td><a href="' + (a.url || '#') + '" style="color:#40D0E0">' + a.nome + '</a></td>' +
                '<td style="text-align:center">' + distancia(alvo.x, alvo.y, a.x, a.y) + '</td>' +
                '<td style="text-align:right">' + fmt(q.madeira) + '</td>' +
                '<td style="text-align:right">' + fmt(q.argila) + '</td>' +
                '<td style="text-align:right">' + fmt(q.ferro) + '</td>' +
                '<td style="text-align:center">' +
                '<input type="button" class="btn btn-confirm-yes cunh-enviar" value="Enviar" ' +
                'data-i="' + i + '" data-m="' + q.madeira + '" data-a="' + q.argila + '" data-f="' + q.ferro + '">' +
                '</td></tr>';
        });

        var avisoProblemas = '';
        if (problemas.length) {
            avisoProblemas = '<tr><td colspan="6" class="cunhErro">⚠️ ' + problemas.length +
                ' aldeia(s) ficaram DE FORA porque não consegui ler os dados: ' +
                problemas.slice(0, 5).map(function (p) { return p.nome + ' (' + p.motivo + ')'; }).join('; ') +
                (problemas.length > 5 ? ' …' : '') +
                '. Nenhum envio foi calculado para elas.</td></tr>';
        }

        var html = CSS +
            '<div id="cunhagem-painel" style="margin:8px 0">' +
            '<table width="100%" style="border-collapse:collapse">' +
            '<tr><td class="cunhH" colspan="6" style="text-align:center">' +
            'Enviando para <b>' + alvo.nome + '</b> (' + alvo.x + '|' + alvo.y + ') · ' +
            alvo.jogador + ' · ' + fmt(alvo.pontos) + ' pontos</td></tr>' +
            '<tr><td class="cunhH" colspan="6">' +
            'Manter no armazém: <input type="text" id="cunh-pct" size="2" value="' + lim + '">% ' +
            '<input type="button" class="btn" id="cunh-recalc" value="Recalcular"> ' +
            '<input type="button" class="btn" id="cunh-trocar" value="Trocar alvo"> ' +
            '<span style="float:right">Enviado: ' +
            '<span id="cunh-tm">0</span> madeira · <span id="cunh-ta">0</span> argila · ' +
            '<span id="cunh-tf">0</span> ferro</span></td></tr>' +
            avisoProblemas +
            '<tr><td class="cunhH">Origem</td><td class="cunhH" style="text-align:center">Dist.</td>' +
            '<td class="cunhH" style="text-align:right">Madeira</td>' +
            '<td class="cunhH" style="text-align:right">Argila</td>' +
            '<td class="cunhH" style="text-align:right">Ferro</td>' +
            '<td class="cunhH" style="text-align:center">Ação</td></tr>' +
            '<tbody id="cunhagem-lista">' + linhas + '</tbody></table>' +
            (enviaveis ? '' : '<div class="cunhErro" style="padding:6px">Nenhuma aldeia tem recurso ' +
                'disponível acima do limite escolhido.</div>') +
            '</div>';

        var onde = document.getElementById('contentContainer') || document.getElementById('mobileHeader');
        if (!onde) { UI.ErrorMessage('Não achei onde encaixar o painel.'); return; }
        var div = document.createElement('div');
        div.innerHTML = html;
        onde.insertBefore(div, onde.firstChild);

        document.getElementById('cunh-recalc').onclick = function () {
            var v = parseInt(document.getElementById('cunh-pct').value, 10);
            if (!isFinite(v) || v < 0 || v > 100) { UI.ErrorMessage('Use um número de 0 a 100.'); return; }
            try { sessionStorage.setItem(CHAVE_LIMITE, String(v)); } catch (e) { }
            montarLista();
        };
        document.getElementById('cunh-trocar').onclick = pedirCoordenada;

        // Um ouvinte só, delegado: as linhas somem conforme os envios confirmam.
        document.getElementById('cunhagem-lista').addEventListener('click', function (ev) {
            var b = ev.target;
            if (!b || !b.classList || !b.classList.contains('cunh-enviar')) return;
            enviar(b);
        });
    }

    // ---------- envio ----------
    function enviar(botao) {
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
            UI.ErrorMessage('Não confirmei o envio de ' + a.nome + ': ' + motivo);
        }

        /*
         * O silêncio é tratado como falha. `TribalWars.post` avisa por CALLBACK, e o script
         * original passava `!1` na 5ª posição — não sei se ali cabe um callback de erro, então
         * NÃO dependo disso: mantenho a mesma forma de chamada e me protejo por conta própria,
         * com relógio. Se em 12 s não vier confirmação, a linha continua na tela em vermelho.
         *
         * O ponto é não repetir o defeito do original, que apagava a linha 200 ms após o clique:
         * envio recusado sumia da tela igual a um que deu certo.
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
            },
            false                                   // mesma forma do original; não invento assinatura
        );
    }

    // ---------- início ----------
    var urlLista = game_data.player.sitter > 0
        ? 'game.php?t=' + game_data.player.id + '&screen=overview_villages&mode=prod&page=-1'
        : 'game.php?screen=overview_villages&mode=prod&page=-1';

    $.get(urlLista).done(function (pagina) {
        var doc = new DOMParser().parseFromString(pagina, 'text/html');
        var n = coletar(doc);
        if (!n) {
            UI.ErrorMessage('Não consegui ler nenhuma aldeia da visão de produção.' +
                (problemas.length ? ' Problemas: ' + problemas[0].motivo : ''));
            return;
        }
        // Só agora pergunta a coordenada: no original os dois corriam juntos e responder rápido
        // montava a lista vazia.
        pedirCoordenada();
    }).fail(function () {
        UI.ErrorMessage('Falhou ao carregar a visão de produção das aldeias.');
    });
})();
