/*
 * DIAGNÓSTICO da tela de Apoio em massa — feito para rodar NO CELULAR/APP, onde não há console.
 *
 * Ele não muda nada e não envia nada: só olha a página e desenha na tela o que encontrou, num
 * campo de texto que dá pra selecionar e copiar.
 *
 * Instalar como um item TEMPORÁRIO da barra rápida:
 *   javascript:$.getScript('https://cdn.jsdelivr.net/gh/Matheusfjuca/Centralatt@main/apoio-diagnostico.js');void(0);
 *
 * Depois de usar, pode apagar o item.
 */

(function () {
    'use strict';

    var L = [];
    function diz(rotulo, valor) { L.push(rotulo + ': ' + valor); }

    function conta(sel) {
        try { return document.querySelectorAll(sel).length; } catch (e) { return 'ERRO'; }
    }

    /* ---------- quem sou eu e onde estou ---------- */
    var g = window.game_data || (typeof unsafeWindow !== 'undefined' && unsafeWindow.game_data);
    diz('URL', String(location.href).replace(/[?&]h=[a-f0-9]+/, '&h=X').slice(0, 120));
    diz('device', g ? (g.device || '?') : 'SEM game_data');
    diz('mobile', String(window.mobile) + ' / on_normal=' + String(window.mobile_on_normal));
    diz('mundo', g ? g.world : '?');
    diz('screen', g ? g.screen : '?');

    /* ---------- a tabela de aldeias ---------- */
    diz('#village_troup_list', conta('#village_troup_list'));
    diz('tr.call-village', conta('tr.call-village'));
    diz('td[data-unit]', conta('td[data-unit]'));
    diz('input.call-unit-box', conta('input.call-unit-box'));
    diz('.troop-request-selector', conta('.troop-request-selector'));
    diz('#place_call_select_all', conta('#place_call_select_all'));
    diz('#place_call_form_submit', conta('#place_call_form_submit'));

    /* ---------- a primeira linha, se houver ---------- */
    var tr = document.querySelector('tr.call-village');
    if (tr) {
        diz('linha[0] id', tr.id || '(sem id)');
        diz('linha[0] colunas', tr.children.length);
        diz('linha[0] col0', (tr.children[0] ? (tr.children[0].innerText || tr.children[0].textContent || '') : '').trim().slice(0, 40));
        diz('linha[0] col1', (tr.children[1] ? (tr.children[1].innerText || tr.children[1].textContent || '') : '').trim().slice(0, 20));
        var td = tr.querySelector('td[data-unit]');
        if (td) {
            diz('td unidade', td.getAttribute('data-unit'));
            diz('td count', td.getAttribute('data-count'));
            diz('td title', td.getAttribute('data-title'));
            var inp = td.querySelector('input');
            diz('input name', inp ? inp.name : '(sem input)');
        } else {
            diz('td[data-unit]', 'NAO EXISTE nesta linha');
        }
    } else {
        /*
         * Sem `tr.call-village` o layout é outro. Estas pistas dizem QUAL outro: quantas tabelas
         * existem, se alguma tem cara de lista de aldeias, e o que está escrito nelas.
         */
        diz('tabelas na pagina', conta('table'));
        var cands = [];
        Array.prototype.slice.call(document.querySelectorAll('table')).forEach(function (t, i) {
            var txt = (t.innerText || t.textContent || '');
            if (/\d{1,3}\|\d{1,3}/.test(txt)) {
                cands.push('#' + i + (t.id ? ('/' + t.id) : '') + (t.className ? ('/.' + String(t.className).split(' ')[0]) : '') +
                           ' linhas=' + t.querySelectorAll('tr').length);
            }
        });
        diz('tabelas com coordenada', cands.length ? cands.join(' | ').slice(0, 200) : 'nenhuma');
        diz('inputs number na pagina', conta('input[type=number]'));
        var qq = document.querySelector('input[name^="call["]');
        diz('algum input call[...]', qq ? qq.name : 'nenhum');
    }

    /* ---------- alvo e grupos ---------- */
    diz('#inputx/#inputy', conta('#inputx') + '/' + conta('#inputy'));
    diz('.village-name', conta('.village-name'));
    var vn = document.querySelector('.village-name');
    if (vn) diz('village-name txt', (vn.innerText || vn.textContent || '').trim().slice(0, 40));

    diz('links group=', conta('a[href*="group="]'));
    var gl = Array.prototype.slice.call(document.querySelectorAll('a[href*="group="]')).slice(0, 5)
        .map(function (a) {
            var m = (a.getAttribute('href') || '').match(/group=(\d+)/);
            return (m ? m[1] : '?') + ':' + (a.innerText || a.textContent || '').trim().slice(0, 14);
        });
    diz('grupos vistos', gl.length ? gl.join(' | ') : 'nenhum');
    diz('game_data.group_id', g ? String(g.group_id) : '?');
    diz('selects na pagina', conta('select'));
    var sel = document.querySelector('select[name*="group"], #group_id');
    diz('select de grupo', sel ? (sel.id || sel.name) + ' ops=' + sel.options.length : 'nenhum');

    /* ---------- hora do servidor ---------- */
    diz('#serverTime/#serverDate', conta('#serverTime') + '/' + conta('#serverDate'));

    /* ---------- o painel do script ---------- */
    diz('#apm-marca', conta('#apm-marca'));
    diz('#apm-painel', conta('#apm-painel'));
