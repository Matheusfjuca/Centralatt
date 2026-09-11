/*
 * CARREGADOR do Apoio em Massa para a BARRA RÁPIDA do jogo (e, por tabela, para o app do celular).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE
 *
 * A barra rápida só aceita URL pública, e o script de verdade mora na VPS. Este arquivo é a ponte:
 * 100 linhas que descobrem quem está pedindo e mandam o jogo carregar o script. A lógica toda
 * (distribuição, envio, seletores) continua na VPS — aqui não tem nada disso.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * COMO INSTALAR (Configurações > Barra de acesso rápido > novo item):
 *
 *   javascript:$.getScript('https://cdn.jsdelivr.net/gh/Matheusfjuca/Centralatt@main/apoio-em-massa-barra.js');void(0);
 *
 * ⚠️ Pelo jsDelivr, NÃO pelo raw.githubusercontent: o GitHub serve com `text/plain` +
 * `X-Content-Type-Options: nosniff`, e aí o navegador se RECUSA a executar o arquivo como script.
 * O jsDelivr entrega o mesmo arquivo do mesmo repositório com `application/javascript`.
 * Medido em 11/09/2026 — foi exatamente por isso que a primeira versão não carregava.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUE `$.getScript` E NÃO `fetch` + `new Function`
 *
 * A primeira versão baixava com `fetch` e executava com `new Function`. Funcionou no PC e NÃO
 * funcionou no app do celular. Os dois são justamente o que uma webview de app costuma restringir:
 * `fetch` pode não existir em webview antiga, e `new Function` cai na proibição de `unsafe-eval`
 * quando há CSP.
 *
 * `$.getScript` não depende de nenhum dos dois — ele injeta uma tag <script>, que é o caminho que
 * a webview aceita (é assim que o script de cunhagem funciona no app). Como a nossa VPS já responde
 * com `Content-Type: application/javascript`, a injeção roda sem esbarrar no nosniff.
 *
 * O preço é perder o código HTTP exato da recusa: numa tag <script>, o navegador não conta se foi
 * 403 ou 404, só que falhou. Por isso a mensagem de erro aqui é mais genérica que a anterior — e
 * essa troca vale a pena, porque mensagem detalhada num script que não roda não serve pra nada.
 */

(function () {
    'use strict';

    var VPS = 'https://aposentados.centraltw.com.br/';
    var ARQUIVO = 'apoio-em-massa.js';
    var PASTA = 'players';

    function avisar(txt) {
        try {
            if (window.UI && UI.ErrorMessage) { UI.ErrorMessage(txt, 5000); return; }
        } catch (e) { /* segue pro alert */ }
        try { alert(txt); } catch (e) { console.log(txt); }
    }

    var w = window;
    var g = w.game_data || (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data);
    if (!g || !g.player || !g.player.name) {
        avisar('Apoio em Massa: abra pela tela do jogo (não consegui identificar sua conta).');
        return;
    }

    /*
     * A tela certa é Praça de Reunião > Apoio em massa. Conferir ANTES de baixar evita o caso
     * confuso de "cliquei e não apareceu nada": o script até carregaria, mas sairia calado por não
     * ser a tela dele.
     *
     * No celular a URL às vezes vem sem `search` (o app monta o endereço de outro jeito), então
     * olha o endereço inteiro, não só a query.
     */
    var endereco = String(location.href || '');
    if (endereco.indexOf('screen=place') < 0 || endereco.indexOf('mode=call') < 0) {
        avisar('Apoio em Massa: abra a Praça de Reunião > Apoio em massa e clique de novo.');
        return;
    }

    if (document.getElementById('apm-marca')) {
        avisar('Apoio em Massa já está aberto nesta tela.');
        return;
    }

    var url = VPS +
        '?nick=' + encodeURIComponent(g.player.name) +
        '&mundo=' + encodeURIComponent(g.world || '') +
        '&tribo=' +
        '&triboId=' + encodeURIComponent(g.player.ally || '') +
        '&pasta=' + PASTA +
        '&arquivo=' + encodeURIComponent(ARQUIVO) +
        '&v=barra';

    /*
     * Sem jQuery não dá pra usar `$.getScript` — mas o jogo sempre tem jQuery, e cair aqui
     * significa que algo bem diferente aconteceu. Avisar é melhor que estourar um TypeError.
     */
    var jq = w.jQuery || w.$;
    if (!jq || !jq.getScript) {
        avisar('Apoio em Massa: o jQuery do jogo não está disponível nesta tela.');
        return;
    }

    jq.getScript(url)
        .done(function () {
            /*
             * Carregou, mas o painel não apareceu: quase sempre é a VPS tendo respondido uma
             * RECUSA (texto curto) em vez do script. Sem o código HTTP, o sinal que sobra é a
             * ausência da marca que o script cria.
             */
            setTimeout(function () {
                if (!document.getElementById('apm-marca')) {
                    avisar('Apoio em Massa: o servidor não liberou o script para esta conta.');
                }
            }, 1200);
        })
        .fail(function () {
            avisar('Apoio em Massa: não consegui carregar da VPS (conexão ou autorização).');
        });
})();
