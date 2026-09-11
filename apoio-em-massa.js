// ==UserScript==
// @name         Apoio em Massa (APOSENTADOS)
// @namespace    tw-apoio-massa-aposentados
// @version      1.0
// @description  Distribui defesa de várias aldeias para um ou vários alvos, com janela de chegada, reserva por aldeia e trava de distância.
// @author       APOSENTADOS
// @match        *://*.tribalwars.com.br/game.php*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/*
 * Nasceu do "Support sender" do Costache Madalin (discord costache madalin#8472), que resolve bem
 * o problema central. Esta é a versão nossa.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * A IDEIA QUE VALE A PENA (e que veio dele): o apoio inteiro viaja na velocidade da tropa MAIS
 * LENTA que vai junto. Então dá pra ESCOLHER a hora de chegada escolhendo o que mandar — até
 * mandando 1 aríete só pra ATRASAR o apoio de propósito. É isso que permite pedir "quero que
 * chegue entre 14h e 15h" em vez de "manda e torce".
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * O QUE SAIU DO ORIGINAL
 *
 * 1. `$.getScript("https://dl.dropboxusercontent.com/.../styleCSSGlobal.js")` — baixava e
 *    EXECUTAVA código de um Dropbox de terceiro dentro da sessão logada, toda vez. Eu baixei e li:
 *    hoje é CSS puro e inofensivo, sem rede e sem tocar em nada sensível. O problema não é o
 *    conteúdo, é o mecanismo — quem controla o link troca o arquivo quando quiser, e o que você
 *    auditou deixa de ser o que roda. Aqui o estilo mora no arquivo.
 * 2. `api.counterapi.dev/...${game_data.player.id}/up` — mandava o ID DO JOGADOR pra um servidor
 *    externo. Contador de uso é legítimo; identificar a conta sem avisar, não.
 * 3. Os 10 temas com editor de cores e slider de largura.
 *
 * O QUE FOI CORRIGIDO (os quatro zeravam ou quebravam o resultado)
 *
 * 1. Data inválida avisava e SEGUIA (sem `return`): com a janela marcada e o campo vazio,
 *    `getTime()` é NaN, toda comparação dá falso, nenhuma aldeia entra e a tela mostra zeros —
 *    igual a "não tenho tropa". Agora barra antes de calcular.
 * 2. `parseInt(...)` da célula de tropa virando NaN fazia a aldeia entrar com 0 em silêncio.
 *    Agora leitura que falha é DESCARTE COM MOTIVO, nunca zero.
 * 3. `valor / listTotalRange.length` com zero aldeias elegíveis dava Infinity nos campos.
 * 4. `row.children[0].innerText.match(...)[0]` estourava numa linha sem coordenada e derrubava
 *    o cálculo inteiro.
 *
 * A distribuição também foi reescrita: o original sorteava o arredondamento
 * (`Math.random() < module`) — dois cliques iguais davam planos diferentes — e dividia por
 * `length - i - 1`, que é ZERO na última aldeia. Aqui é enchimento por nível + maior resto:
 * determinístico e com soma exata.
 *
 * ⚠️ A MUDANÇA MAIS IMPORTANTE: O TEMPO VEM DO JOGO, NÃO DE CONTA NOSSA
 *
 * Medido ao vivo no br143 (11/09/2026), cada célula da tabela já traz a duração da viagem:
 *
 *     <td data-unit="spear" data-count="357" data-title="Duração: 0:18:00">
 *
 * O original calculava isso à mão: buscava velocidade do mundo e das unidades em
 * `/interface.php?func=get_config` (com XMLHttpRequest SÍNCRONO, travando a aba), multiplicava
 * pela distância e ainda pedia o SIGILO num campo pro jogador digitar. Cada etapa é uma chance
 * de errar, e o erro só aparece quando o apoio chega na hora errada.
 *
 * Lendo `data-title`, o número é o do próprio jogo — já com sigilo, bandeiras, paladino e as
 * regras do mundo embutidos. Sumiram: a requisição de configuração, a tabela de velocidades, o
 * campo de sigilo e a conta de distância. E funciona em qualquer mundo, com arqueiro ou sem.
 *
 * A ordem de lentidão também deixa de ser tabela fixa: sai das próprias durações lidas.
 */

(function () {
    'use strict';

    /* ==========================================================================================
     *  MOTOR — daqui até "FIM DO MOTOR" é função pura: sem DOM, sem rede, sem game_data.
     *  É de propósito: dá pra testar a matemática inteira sem o jogo aberto.
     * ======================================================================================== */

    /*
     * População que cada unidade ocupa, para a conta de "pacotes" de defesa.
     *
     * ⚠️ Cavalaria Pesada usa 4, NÃO a população real 6 — mesma convenção do nosso Contador de
     * Tropas: o que interessa é quanto ela VALE DE DEFESA (4 unidades de def), não quanto ocupa
     * de fazenda. O script original usava 4 pelo mesmo motivo. Não "corrigir" para 6.
     */
    var POP_DEFESA = { spear: 1, sword: 1, archer: 1, heavy: 4, spy: 0 };

    /* O que conta como defesa enviável. Espião vai junto como olho, sem valor defensivo. */
    var UNIDADES_DEFESA = ['spear', 'sword', 'archer', 'heavy', 'spy'];

    /* Servem só como marca-passo: 1 unidade pra segurar o apoio no ritmo delas. */
    var MARCA_PASSO = ['ram', 'catapult'];

    /*
     * "Duração: 0:18:00" -> 1080000 ms. Devolve null quando não dá pra ler — e null aqui tem que
     * continuar null até a tela, porque tempo desconhecido não é tempo zero.
     */
    function duracaoParaMs(texto) {
        if (!texto) return null;
        var m = String(texto).match(/(\d+):(\d{2}):(\d{2})/);
        if (!m) return null;
        return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
    }

    /*
     * A DECISÃO CENTRAL: qual unidade dita o ritmo deste apoio.
     *
     * Queremos a MAIS LENTA que ainda caiba na janela:
     *   - mais lenta = chega mais tarde = mais perto do fim da janela, que é onde a defesa serve
     *     (defesa que chega cedo demais pode sair antes do ataque, ou entregar a jogada);
     *   - e é o que permite usar 1 aríete só pra atrasar de propósito.
     *
     * Sem janela marcada, o ritmo é a tropa de defesa mais lenta que a aldeia realmente TEM —
     * aríete e catapulta ficam fora, porque aí seriam atraso sem motivo.
     *
     * A ordem de lentidão sai das DURAÇÕES LIDAS DO JOGO, não de tabela nossa: é o que faz isto
     * valer em qualquer mundo e já com todos os bônus da conta embutidos.
     */
    function escolherUnidadeDeRitmo(aldeia, janela, comJanela) {
        var candidatas = [];

        Object.keys(aldeia.duracao).forEach(function (u) {
            var ms = aldeia.duracao[u];
            if (ms === null || ms === undefined) return;

            var ehMarcaPasso = MARCA_PASSO.indexOf(u) >= 0;
            var ehDefesa = UNIDADES_DEFESA.indexOf(u) >= 0;
            if (!ehMarcaPasso && !ehDefesa) return;          // bárbaro, lança-leve, nobre: fora
            if (ehMarcaPasso && !comJanela) return;          // atraso só existe pra acertar horário

            var precisa = ehMarcaPasso ? 1 : 1;              // 1 unidade já segura o ritmo
            if ((aldeia.tropas[u] || 0) < precisa) return;   // ritmo de tropa que não vai é mentira

            candidatas.push({ unidade: u, duracao: ms });
        });

        candidatas.sort(function (a, b) { return b.duracao - a.duracao; });   // da mais lenta

        for (var i = 0; i < candidatas.length; i++) {
            var chega = janela.agora + candidatas[i].duracao;
            if (!comJanela) return { unidade: candidatas[i].unidade, chegada: chega, duracao: candidatas[i].duracao };
            if (chega >= janela.inicio && chega <= janela.fim) {
                return { unidade: candidatas[i].unidade, chegada: chega, duracao: candidatas[i].duracao };
            }
        }
        return null;
    }

    /*
     * Tropa mais rápida que o marca-passo chega ANTES e estraga o horário; tropa mais lenta
     * atrasaria o apoio inteiro. Só vai junto quem é igual ou mais rápido — o apoio chega no
     * tempo do mais lento, que é justamente o marca-passo.
     */
    function acompanha(duracaoUnidade, duracaoRitmo) {
        if (duracaoUnidade === null || duracaoUnidade === undefined) return false;
        return duracaoUnidade <= duracaoRitmo;
    }

    /*
     * Quem entra, quem fica de fora, e o MOTIVO de cada exclusão.
     *
     * O original só devolvia os elegíveis; quem sumia, sumia sem explicação — e "não tenho tropa"
     * ficava indistinguível de "não consegui ler".
     */
    function selecionarAldeias(aldeias, opcoes) {
        var elegiveis = [], fora = [];
        var janela = opcoes.janela || {};
        var comJanela = !!opcoes.comJanela;

        aldeias.forEach(function (a) {
            if (a.erroLeitura) {
                fora.push({ coord: a.coord, motivo: 'não consegui ler as tropas' });
                return;
            }
            if (opcoes.distanciaMax && a.distancia > opcoes.distanciaMax) {
                fora.push({ coord: a.coord, motivo: 'a ' + a.distancia.toFixed(1) + ' campos (limite ' + opcoes.distanciaMax + ')' });
                return;
            }

            /* O que sobra depois da reserva que fica em casa. */
            var livre = {}, temDefesa = false;
            UNIDADES_DEFESA.forEach(function (u) {
                var total = a.tropas[u] || 0;
                var guardar = (opcoes.reserva && opcoes.reserva[u]) || 0;
                var sobra = Math.max(0, total - guardar);
                livre[u] = sobra;
                if (sobra > 0 && POP_DEFESA[u] > 0) temDefesa = true;
            });
            /* Marca-passo não sofre reserva: 1 aríete é ferramenta de horário, não defesa. */
            MARCA_PASSO.forEach(function (u) { livre[u] = a.tropas[u] || 0; });

            if (!temDefesa) {
                fora.push({ coord: a.coord, motivo: 'sem tropa livre depois da reserva' });
                return;
            }

            var ritmo = escolherUnidadeDeRitmo(
                { tropas: livre, duracao: a.duracao }, janela, comJanela);

            if (!ritmo) {
                fora.push({ coord: a.coord, motivo: comJanela ? 'nada chega dentro da janela' : 'sem tempo de viagem legível' });
                return;
            }

            var enviavel = {};
            UNIDADES_DEFESA.forEach(function (u) {
                enviavel[u] = acompanha(a.duracao[u], ritmo.duracao) ? livre[u] : 0;
            });

            elegiveis.push({
                coord: a.coord, id: a.id, distancia: a.distancia,
                unidadeDeRitmo: ritmo.unidade, chegada: ritmo.chegada, duracao: ritmo.duracao,
                // o mapa inteiro viaja junto: é o que permite recalcular o ritmo REAL depois de
                // saber o que a distribuição de fato mandou
                duracoes: a.duracao, agora: (janela.agora || 0),
                disponivel: enviavel
            });
        });

        return { elegiveis: elegiveis, fora: fora };
    }

    /*
     * DISTRIBUIÇÃO de um pedido entre as aldeias, por unidade.
     *
     * Enchimento por nível: reparte em partes iguais; quem não tem o bastante entrega tudo o que
     * tem e sai da roda; o que sobrou é repartido de novo entre as que restam, até estabilizar.
     * Assim as aldeias grandes cobrem o buraco das pequenas sem ninguém mandar o que não tem.
     *
     * Os inteiros saem por MAIOR RESTO, o que fecha a soma exata sem sorteio.
     */
    function distribuirUnidade(disponiveis, pedido) {
        var n = disponiveis.length;
        var plano = new Array(n).fill(0);
        if (n === 0 || !(pedido > 0)) return plano;

        var capacidade = disponiveis.reduce(function (s, v) { return s + v; }, 0);
        var alvo = Math.min(pedido, capacidade);
        if (alvo <= 0) return plano;

        var fechadas = new Array(n).fill(false);
        var exato = new Array(n).fill(0);
        var restante = alvo;

        for (var volta = 0; volta < n + 1 && restante > 1e-9; volta++) {
            var abertas = [];
            for (var i = 0; i < n; i++) if (!fechadas[i]) abertas.push(i);
            if (!abertas.length) break;

            var cota = restante / abertas.length;
            var travou = false;

            abertas.forEach(function (idx) {
                var cabe = disponiveis[idx] - exato[idx];
                if (cabe <= cota) {                  // entrega tudo e sai da roda
                    exato[idx] += cabe;
                    restante -= cabe;
                    fechadas[idx] = true;
                    travou = true;
                }
            });

            if (!travou) {                            // ninguém estourou: divide o resto e acabou
                abertas.forEach(function (idx) { exato[idx] += cota; });
                restante = 0;
            }
        }

        var piso = exato.map(function (v) { return Math.floor(v); });
        var faltam = Math.round(alvo) - piso.reduce(function (s, v) { return s + v; }, 0);

        var ordem = exato.map(function (v, i) { return { i: i, resto: v - Math.floor(v) }; })
            .sort(function (a, b) { return b.resto - a.resto || a.i - b.i; });

        for (var k = 0; k < ordem.length && faltam > 0; k++) {
            var idx2 = ordem[k].i;
            if (piso[idx2] < disponiveis[idx2]) { piso[idx2]++; faltam--; }
        }
        for (var passo = 0; passo < n && faltam > 0; passo++) {      // empates em zero
            for (var j = 0; j < n && faltam > 0; j++) {
                if (piso[j] < disponiveis[j]) { piso[j]++; faltam--; }
            }
        }

        return piso;
    }

    /* Monta o plano final de UM alvo: quanto de cada unidade sai de cada aldeia. */
    function montarPlano(elegiveis, pedido, comJanela) {
        var plano = elegiveis.map(function (e) {
            return {
                coord: e.coord, id: e.id, distancia: e.distancia, chegada: e.chegada,
                unidadeDeRitmo: e.unidadeDeRitmo, envio: {},
                _duracoes: e.duracoes || {}, _agora: e.agora || 0
            };
        });

        UNIDADES_DEFESA.forEach(function (u) {
            var disp = elegiveis.map(function (e) { return e.disponivel[u] || 0; });
            distribuirUnidade(disp, pedido[u] || 0)
                .forEach(function (q, i) { plano[i].envio[u] = q; });
        });

        plano.forEach(function (p) {
            MARCA_PASSO.forEach(function (u) { p.envio[u] = 0; });

            /*
             * O marca-passo só vai quando há janela: é 1 unidade cuja única função é SEGURAR o
             * apoio no ritmo certo. Sem janela seria tropa jogada fora.
             */
            if (comJanela && MARCA_PASSO.indexOf(p.unidadeDeRitmo) >= 0) {
                p.envio[p.unidadeDeRitmo] = 1;
            }

            /*
             * Se quem dita o ritmo é tropa de defesa e a distribuição não deu nenhuma pra esta
             * aldeia, o apoio viajaria mais rápido do que o planejado e cairia FORA da janela.
             * Uma unidade resolve.
             */
            if (comJanela && UNIDADES_DEFESA.indexOf(p.unidadeDeRitmo) >= 0
                && (p.envio[p.unidadeDeRitmo] || 0) === 0) {
                p.envio[p.unidadeDeRitmo] = 1;
            }

            p.total = Object.keys(p.envio).reduce(function (s, u) { return s + (p.envio[u] || 0); }, 0);
            p.pop = popDoConjunto(p.envio);

            /*
             * RITMO REAL: a tropa mais lenta ENTRE AS QUE VÃO. É ela que define a chegada, então é
             * ela que a tela precisa mostrar. Sem isto, pedir só cavalaria num plano cujo
             * marca-passo era a espada exibia o horário da espada — mais tarde do que a verdade.
             */
            var maisLenta = null, duracaoReal = -1;
            Object.keys(p.envio).forEach(function (u) {
                if (!(p.envio[u] > 0)) return;
                var d = p._duracoes[u];
                if (d === null || d === undefined) return;
                if (d > duracaoReal) { duracaoReal = d; maisLenta = u; }
            });
            if (maisLenta) {
                p.unidadeDeRitmo = maisLenta;
                if (p._agora) p.chegada = p._agora + duracaoReal;
            }
            delete p._duracoes;
            delete p._agora;
        });

        return plano.filter(function (p) { return p.total > 0; });
    }

    function popDoConjunto(tropas) {
        return UNIDADES_DEFESA.reduce(function (s, u) {
            return s + (tropas[u] || 0) * (POP_DEFESA[u] || 0);
        }, 0);
    }

    /*
     * "QUERO 80k DE DEFESA AQUI" -> quanto de cada unidade.
     *
     * O pedido natural é em POPULAÇÃO de defesa ("80k"), não em "35.000 lanças e 3.000 CP". A
     * conversão é proporcional ao que EXISTE: se o disponível é 70% lança e 30% CP (medido em
     * pop), o pedido se reparte na mesma proporção. Assim ninguém pede 40k de espada numa conta
     * que só tem lança.
     *
     * Espião não entra: pop de defesa 0. Ele é tratado à parte (tantos por aldeia), porque vai
     * junto como olho, não como defesa.
     */
    function pedidoPorPop(popDesejada, disponivelTotal) {
        var pedido = {};
        UNIDADES_DEFESA.forEach(function (u) { pedido[u] = 0; });
        if (!(popDesejada > 0)) return pedido;

        var comPop = UNIDADES_DEFESA.filter(function (u) { return POP_DEFESA[u] > 0; });
        var popPorUnidade = {}, popTotal = 0;
        comPop.forEach(function (u) {
            popPorUnidade[u] = (disponivelTotal[u] || 0) * POP_DEFESA[u];
            popTotal += popPorUnidade[u];
        });
        if (popTotal <= 0) return pedido;

        var querPop = Math.min(popDesejada, popTotal);

        /*
         * Arredondar pra baixo em cada unidade deixaria a soma abaixo do pedido; o resto é
         * devolvido por MAIOR SOBRA, do mesmo jeito que a distribuição entre aldeias. Sem isso o
         * total pedido "encolhia" sozinho e a diferença aparecia como falta que não existe.
         */
        var bruto = {}, faltaPop = querPop;
        comPop.forEach(function (u) {
            var fatia = querPop * (popPorUnidade[u] / popTotal);
            var qtd = Math.floor(fatia / POP_DEFESA[u]);
            qtd = Math.min(qtd, disponivelTotal[u] || 0);
            bruto[u] = qtd;
            faltaPop -= qtd * POP_DEFESA[u];
        });

        // completa com quem ainda tem folga, da unidade de menor pop pra cima (erra menos)
        comPop.slice().sort(function (a, b) { return POP_DEFESA[a] - POP_DEFESA[b]; })
            .forEach(function (u) {
                while (faltaPop >= POP_DEFESA[u] && bruto[u] < (disponivelTotal[u] || 0)) {
                    bruto[u]++;
                    faltaPop -= POP_DEFESA[u];
                }
            });

        comPop.forEach(function (u) { pedido[u] = bruto[u]; });
        return pedido;
    }

    /* Soma a tropa livre de um conjunto de aldeias, por unidade. */
    function somarDisponivel(elegiveis) {
        var total = {};
        UNIDADES_DEFESA.forEach(function (u) {
            total[u] = elegiveis.reduce(function (s, e) { return s + (e.disponivel[u] || 0); }, 0);
        });
        return total;
    }

    /*
     * VÁRIOS ALVOS — a parte que o original não tinha.
     *
     * A tela do jogo é de UM destino por vez, então o plano precisa lembrar que a tropa é a mesma
     * para todos: o que o alvo 1 levar não está mais disponível para o alvo 2. Aqui os alvos são
     * processados NA ORDEM DA LISTA (a ordem é a prioridade) e cada um consome do saldo restante.
     *
     * A elegibilidade é POR PAR (aldeia, alvo): a aldeia que está a 8 campos do primeiro pode
     * estar a 40 do terceiro, e cada alvo tem a sua janela. Por isso cada alvo recebe o seu
     * próprio `selecionarAldeias`.
     *
     * ⚠️ Limite conhecido e assumido: quem vem primeiro escolhe primeiro. Uma aldeia que só
     * alcança o último alvo pode ter sido gasta no primeiro, que tinha outras doze opções.
     * Reservar as aldeias "exclusivas" seria melhor e fica pra depois — por ora a ordem é sua e
     * o painel avisa quando um alvo fica faltando.
     */
    function planejarVariosAlvos(alvos, aldeiasPorAlvo, opcoesBase) {
        var gasto = {};          // id da aldeia -> { unidade: quanto já foi }
        var resultado = [];

        alvos.forEach(function (alvo, indice) {
            var aldeias = (aldeiasPorAlvo[alvo.coord] || []).map(function (a) {
                var jaGasto = gasto[a.id] || {};
                var tropas = {};
                Object.keys(a.tropas).forEach(function (u) {
                    tropas[u] = Math.max(0, (a.tropas[u] || 0) - (jaGasto[u] || 0));
                });
                return {
                    coord: a.coord, id: a.id, distancia: a.distancia,
                    duracao: a.duracao, tropas: tropas, erroLeitura: a.erroLeitura
                };
            });

            var opcoes = {
                distanciaMax: alvo.distanciaMax || opcoesBase.distanciaMax,
                reserva: opcoesBase.reserva,
                comJanela: !!alvo.janela,
                janela: alvo.janela || { agora: opcoesBase.agora }
            };
            if (!opcoes.janela.agora) opcoes.janela.agora = opcoesBase.agora;

            var sel = selecionarAldeias(aldeias, opcoes);
            var plano = montarPlano(sel.elegiveis, alvo.pedido || {}, opcoes.comJanela);

            plano.forEach(function (p) {
                if (!gasto[p.id]) gasto[p.id] = {};
                Object.keys(p.envio).forEach(function (u) {
                    gasto[p.id][u] = (gasto[p.id][u] || 0) + (p.envio[u] || 0);
                });
            });

            var entregue = {};
            UNIDADES_DEFESA.forEach(function (u) {
                entregue[u] = plano.reduce(function (s, p) { return s + (p.envio[u] || 0); }, 0);
            });

            var faltando = {};
            var faltaAlgo = false;
            UNIDADES_DEFESA.forEach(function (u) {
                var f = Math.max(0, (alvo.pedido[u] || 0) - entregue[u]);
                if (f > 0) { faltando[u] = f; faltaAlgo = true; }
            });

            resultado.push({
                indice: indice, coord: alvo.coord, plano: plano, fora: sel.fora,
                entregue: entregue, popEntregue: popDoConjunto(entregue),
                faltando: faltaAlgo ? faltando : null,
                aldeiasUsadas: plano.length
            });
        });

        return { alvos: resultado, gastoPorAldeia: gasto };
    }

    /* ===================================== FIM DO MOTOR ===================================== */

    /* ==========================================================================================
     *  DAQUI PRA BAIXO É TELA E JOGO.
     * ======================================================================================== */

    /* Só carrega na Praça de Reunião -> Apoio em massa. */
    if (!/screen=place/.test(location.search) || !/mode=call/.test(location.search)) return;

    var CHAVE = 'apoio_massa_' + (window.game_data ? game_data.world : 'x');
    var UN_PT = {
        spear: 'Lança', sword: 'Espada', archer: 'Arqueiro', heavy: 'CP', spy: 'Espião',
        ram: 'Aríete', catapult: 'Catapulta'
    };

    /* ------------------------------------ estado salvo ------------------------------------ */

    function estadoPadrao() {
        return {
            alvos: [],                 // [{coord, popK, usarJanela, inicio, fim}]
            reserva: {}, espioes: 0, distanciaMax: null,
            pos: null, posBt: null, minimizado: false
        };
    }

    function lerEstado() {
        try {
            var bruto = localStorage.getItem(CHAVE);
            if (!bruto) return estadoPadrao();
            var e = JSON.parse(bruto);
            var p = estadoPadrao();
            Object.keys(p).forEach(function (k) { if (e[k] === undefined) e[k] = p[k]; });
            return e;
        } catch (err) {
            // config corrompida não pode derrubar o script: começa limpo e segue
            console.warn('[Apoio em Massa] config ilegível, recomeçando', err);
            return estadoPadrao();
        }
    }

    function gravarEstado() {
        try {
            localStorage.setItem(CHAVE, JSON.stringify(EST));
        } catch (err) {
            // localStorage cheio é problema conhecido nesta conta (cache de terceiros).
            // Falhar em salvar NÃO pode impedir de usar — avisa e continua.
            avisar('Não consegui salvar as configurações (armazenamento cheio). O cálculo funciona normal.', 'erro');
        }
    }

    var EST = lerEstado();

    /* ------------------------------ leitura da tela do jogo ------------------------------- */

    /*
     * A tabela do jogo, medida ao vivo no br143 (11/09/2026):
     *
     *   <tr id="call_village_96564" class="call-village">
     *     <td><a>003 - NOME (409|326) K34</a></td>     <- coordenada
     *     <td>1.0</td>                                  <- distância JÁ CALCULADA pelo jogo
     *     <td data-unit="spear" data-count="357" data-title="Duração: 0:18:00">
     *       <input class="call-unit-box call-unit-box-spear" name="call[96564][spear]" disabled>
     *
     * Tudo o que o script precisa está aí: quantidade, distância e TEMPO DE VIAGEM REAL — este
     * último já com sigilo, bandeiras e paladino embutidos, que é o que dispensa calcular nada.
     */
    /*
     * Texto de um elemento, de forma que NUNCA devolva undefined.
     *
     * `el ? el.innerText : ''` parece seguro e não é: quando o elemento existe mas não tem
     * `innerText` (acontece fora do navegador e em nós não renderizados), o retorno é undefined e
     * o `.match()` seguinte estoura — derrubando a leitura inteira. É o mesmo tipo de tropeço que
     * derrubava o script original numa linha sem coordenada.
     */
    function texto(el) {
        if (!el) return '';
        var t = el.innerText;
        if (t === undefined || t === null) t = el.textContent;
        return (t === undefined || t === null) ? '' : String(t);
    }

    /*
     * `GRUPO_CARREGADO` guarda a lista trazida por fetch de outro grupo. Enquanto existir, é ELA a
     * fonte — a tabela da tela continua mostrando o grupo antigo, e misturar as duas daria um
     * número que não corresponde a nada.
     */
    var GRUPO_CARREGADO = null;   // { id, nome, aldeias: [...] }

    function lerAldeias() {
        if (GRUPO_CARREGADO) return GRUPO_CARREGADO.aldeias;
        return lerAldeiasDe(document);
    }

    function lerAldeiasDe(doc) {
        var tabela = doc.querySelector('#village_troup_list');
        if (!tabela) return null;                       // sem tabela não há "zero aldeias": há erro

        var linhas = Array.from(tabela.querySelectorAll('tr.call-village'));
        return linhas.map(function (tr) {
            var idm = (tr.id || '').match(/call_village_(\d+)/);
            var coordm = texto(tr.children[0]).match(/(\d{1,3})\|(\d{1,3})/);
            var dist = parseFloat(texto(tr.children[1]).replace(',', '.'));

            var tropas = {}, duracao = {}, leuAlguma = false;
            Array.from(tr.querySelectorAll('td[data-unit]')).forEach(function (td) {
                var u = td.dataset.unit;
                var n = parseInt(td.dataset.count, 10);
                tropas[u] = isNaN(n) ? 0 : n;
                if (!isNaN(n)) leuAlguma = true;
                duracao[u] = duracaoParaMs(td.dataset.title);
            });

            /*
             * Linha sem coordenada legível, sem id ou sem nenhuma contagem é DESCARTE COM MOTIVO,
             * nunca uma aldeia com tropa zero. No original, `match(...)[0]` numa linha assim
             * estourava e derrubava o cálculo inteiro.
             */
            var erro = !coordm || !idm || !leuAlguma;

            return {
                id: idm ? idm[1] : null,
                coord: coordm ? coordm[0] : ('linha ' + (tr.id || '?')),
                distancia: isNaN(dist) ? 0 : dist,
                tropas: tropas, duracao: duracao, erroLeitura: erro, tr: tr
            };
        });
    }

    /* Quais unidades este mundo tem (o br143 não tem arqueiro, por exemplo). */
    function unidadesDoMundo() {
        return UNIDADES_DEFESA.filter(function (u) {
            return !!document.querySelector('td[data-unit="' + u + '"]');
        });
    }

    /*
     * Os grupos que o jogo mostra nesta página. Cada link tem `group=<id>` e o nome como texto.
     * O grupo em uso vem de `game_data.group_id` ('0' = todos).
     *
     * Deduplica por id porque o jogo repete os mesmos links em mais de um lugar da página.
     */
    function gruposDaPagina() {
        var vistos = {}, lista = [{ id: '0', nome: 'todos' }];
        Array.from(document.querySelectorAll('a[href*="group="]')).forEach(function (a) {
            var m = (a.getAttribute('href') || '').match(/[?&]group=(\d+)/);
            if (!m) return;
            var id = m[1];
            if (id === '0' || vistos[id]) return;
            var nome = texto(a).trim().replace(/^[\[\s>]+|[\]\s<]+$/g, '');
            if (!nome) return;
            vistos[id] = true;
            lista.push({ id: id, nome: nome });
        });
        return lista;
    }

    function nomeDoGrupoAtual() {
        var id = grupoAtual();
        var achado = gruposDaPagina().filter(function (g) { return g.id === id; })[0];
        return achado ? achado.nome : (id === '0' ? 'todos' : id);
    }

    function grupoAtual() {
        var m = location.search.match(/[?&]group=(\d+)/);
        if (m) return m[1];
        return (window.game_data && game_data.group_id != null) ? String(game_data.group_id) : '0';
    }

    /* A mesma tela, com outro grupo — usada tanto pelo fetch quanto pelo recarregar. */
    function urlDoGrupo(id) {
        var url = location.href.replace(/([?&])group=\d+/, '$1group=' + id);
        if (url === location.href) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'group=' + id;
        return url;
    }

    /* Plano B: recarrega a tela. Só usado quando o fetch não trouxe uma tabela utilizável. */
    function trocarGrupoRecarregando(id) {
        location.href = urlDoGrupo(id);
    }

    /*
     * Busca a lista de aldeias de um grupo sem sair da tela.
     *
     * Devolve null quando a resposta não serve — e null aqui vira "não consegui, vou recarregar",
     * nunca "este grupo não tem aldeias".
     */
    async function buscarAldeiasDoGrupo(id, nome) {
        var resp, html;
        try {
            resp = await fetch(urlDoGrupo(id), { credentials: 'same-origin' });
            if (!resp.ok) return null;
            html = await resp.text();
        } catch (e) {
            return null;
        }
        if (/bot_check|botprotection|hcaptcha/i.test(html)) return { captcha: true };

        var doc;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }

        var lista = lerAldeiasDe(doc);
        if (!lista || !lista.length) return null;       // tabela ausente ou vazia: não serve

        // toda linha ilegível é sinal de que o HTML veio diferente do esperado
        var boas = lista.filter(function (a) { return !a.erroLeitura; });
        if (!boas.length) return null;

        return { id: String(id), nome: nome, aldeias: lista };
    }

    function alvoAtual() {
        var x = document.querySelector('#inputx'), y = document.querySelector('#inputy');
        if (x && y && x.value && y.value) return x.value.trim() + '|' + y.value.trim();
        var vn = document.querySelector('.village-name');
        var m = vn ? texto(vn).match(/(\d{1,3})\|(\d{1,3})/) : null;
        return m ? m[0] : null;
    }

    /*
     * Hora do SERVIDOR, que é a única que importa aqui — a janela é comparada com a chegada
     * calculada pelo jogo. `serverDate` vem DD/MM/AAAA.
     */
    function agoraDoServidor() {
        var h = document.querySelector('#serverTime'), d = document.querySelector('#serverDate');
        if (!h || !d) return Date.now();
        var pd = texto(d).trim().split('/');
        var ph = texto(h).trim().split(':');
        if (pd.length !== 3 || ph.length !== 3) return Date.now();
        return new Date(+pd[2], +pd[1] - 1, +pd[0], +ph[0], +ph[1], +ph[2]).getTime();
    }

    /* ------------------------------------- utilidades ------------------------------------- */

    var nf = function (n) { return (n || 0).toLocaleString('pt-BR'); };
    var esc = function (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };
    function hhmm(ms) {
        var d = new Date(ms);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    /*
     * "14:30" ou "11/09/2026 14:30" -> tempo absoluto, EM HORA DO SERVIDOR.
     * Só hora: assume hoje; se já passou, entende como amanhã (é o que a pessoa quer dizer ao
     * escrever "02:00" às 23h).
     * Devolve null quando não dá pra ler — e null aqui BARRA o cálculo, em vez de virar NaN e
     * zerar tudo em silêncio, que era o defeito do original.
     */
    function lerMomento(txt, agora) {
        if (!txt) return null;
        txt = String(txt).trim();
        var comData = txt.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        var soHora = txt.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        var base = new Date(agora);

        if (comData) {
            var ano = comData[3] ? +comData[3] : base.getFullYear();
            var dt = new Date(ano, +comData[2] - 1, +comData[1], +comData[4], +comData[5], +(comData[6] || 0));
            return isNaN(dt.getTime()) ? null : dt.getTime();
        }
        if (soHora) {
            var d2 = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
                              +soHora[1], +soHora[2], +(soHora[3] || 0));
            if (isNaN(d2.getTime())) return null;
            if (d2.getTime() < agora) d2.setDate(d2.getDate() + 1);   // "02:00" às 23h = amanhã
            return d2.getTime();
        }
        return null;
    }

    /*
     * Espiões por aldeia DESTE alvo: o campo da linha, ou o padrão dos Ajustes quando vazio.
     * Campo vazio e campo com "0" são coisas diferentes — vazio herda, zero é zero de propósito.
     */
    function espioesDoAlvo(a) {
        var v = (a && a.espioes !== undefined && a.espioes !== null) ? String(a.espioes).trim() : '';
        if (v === '') {
            var g = parseInt(EST.espioes, 10);
            return isNaN(g) ? 0 : Math.max(0, g);
        }
        var nn = parseInt(v, 10);
        return isNaN(nn) ? 0 : Math.max(0, nn);
    }

    /*
     * Quanto este alvo está pedindo, em POPULAÇÃO — vale nos dois modos.
     *
     * Modo "pop": o número que você digitou.
     * Modo "tipo": a soma do que você pediu de cada tropa, convertida em pop (CP vale 4).
     *
     * Ter os dois modos falando a mesma moeda é o que permite o orçamento no rodapé continuar
     * fazendo sentido quando você mistura alvos dos dois jeitos.
     */
    function popPedidaDoAlvo(a) {
        if (a && a.modo === 'tipo') {
            var soma = 0;
            UNIDADES_DEFESA.forEach(function (u) {
                if (!POP_DEFESA[u]) return;
                var v = parseFloat(String((a.porTipo || {})[u] || '').replace(',', '.'));
                if (v > 0) soma += v * 1000 * POP_DEFESA[u];
            });
            return soma;
        }
        var p = parseFloat(String(a && a.popK).replace(',', '.'));
        return p > 0 ? p * 1000 : 0;
    }

    /*
     * Quanto este alvo pede DE CADA TROPA.
     *
     * No modo "tipo" é o que você digitou. No modo "pop" é a repartição proporcional que o
     * cálculo faria — precisa do que está livre para saber a proporção, então recebe `livre`.
     * É isto que permite o rodapé subtrair tropa a tropa antes de qualquer cálculo.
     */
    function pedidoPorUnidadeDoAlvo(a, livre) {
        var fora = {};
        UNIDADES_DEFESA.forEach(function (u) { fora[u] = 0; });

        if (a && a.modo === 'tipo') {
            UNIDADES_DEFESA.forEach(function (u) {
                if (!POP_DEFESA[u]) return;
                var v = parseFloat(String((a.porTipo || {})[u] || '').replace(',', '.'));
                fora[u] = (v > 0) ? Math.round(v * 1000) : 0;
            });
            return fora;
        }

        var popK = parseFloat(String(a && a.popK).replace(',', '.'));
        if (!(popK > 0)) return fora;
        return pedidoPorPop(popK * 1000, livre);
    }

    /* ------------------------------------- o cálculo -------------------------------------- */

    /*
     * Roda o plano de TODOS os alvos. Devolve também os erros de preenchimento, porque a regra
     * aqui é: se a entrada está ruim, PARA e diz — nunca calcula com NaN.
     */
    function calcular() {
        var aldeias = lerAldeias();
        if (!aldeias) return { erro: 'Não achei a tabela de aldeias nesta tela.' };
        if (!aldeias.length) return { erro: 'A tabela não tem nenhuma aldeia.' };

        var agora = agoraDoServidor();
        var problemas = [];
        var alvos = [];

        EST.alvos.forEach(function (a, i) {
            var rotulo = 'alvo ' + (i + 1) + ' (' + (a.coord || 'sem coordenada') + ')';
            if (!/^\d{1,3}\|\d{1,3}$/.test(String(a.coord || '').trim())) {
                problemas.push(rotulo + ': coordenada inválida'); return;
            }
            var popPedida = popPedidaDoAlvo(a);
            if (!(popPedida > 0)) {
                problemas.push(rotulo + (a.modo === 'tipo'
                    ? ': nenhuma tropa pedida (preencha ao menos um tipo)'
                    : ': quantidade inválida'));
                return;
            }

            var janela = null;
            if (a.usarJanela) {
                var ini = lerMomento(a.inicio, agora);
                var fim = lerMomento(a.fim, agora);
                if (ini === null) { problemas.push(rotulo + ': horário de início não entendi (use 14:30 ou 11/09 14:30)'); return; }
                if (fim === null) { problemas.push(rotulo + ': horário de fim não entendi'); return; }
                if (fim <= ini) { problemas.push(rotulo + ': o fim da janela é antes do início'); return; }
                janela = { agora: agora, inicio: ini, fim: fim };
            }

            alvos.push({
                coord: String(a.coord).trim(), popPedida: popPedida, janela: janela,
                modo: a.modo === 'tipo' ? 'tipo' : 'pop',
                porTipo: a.porTipo || {}, espioes: espioesDoAlvo(a), indiceOriginal: i
            });
        });

        if (problemas.length) return { erro: problemas.join('\n') };
        if (!alvos.length) return { erro: 'Adicione pelo menos um alvo.' };

        /*
         * O pedido de cada alvo é em POP e precisa virar quantidade por unidade — e isso depende
         * do que está DISPONÍVEL para aquele alvo (que muda com distância e janela). Por isso a
         * conversão acontece alvo a alvo, já descontando o que os anteriores levaram.
         */
        var gasto = {};
        var saida = [];

        alvos.forEach(function (alvo) {
            var aldeiasComSaldo = aldeias.map(function (a) {
                var g = gasto[a.id] || {};
                var t = {};
                Object.keys(a.tropas).forEach(function (u) {
                    t[u] = Math.max(0, (a.tropas[u] || 0) - (g[u] || 0));
                });
                return { id: a.id, coord: a.coord, distancia: a.distancia, duracao: a.duracao,
                         tropas: t, erroLeitura: a.erroLeitura };
            });

            var opcoes = {
                distanciaMax: EST.distanciaMax, reserva: EST.reserva,
                comJanela: !!alvo.janela, janela: alvo.janela || { agora: agora }
            };

            var sel = selecionarAldeias(aldeiasComSaldo, opcoes);
            var disp = somarDisponivel(sel.elegiveis);
            var pedido;

            if (alvo.modo === 'tipo') {
                /*
                 * Pedido explícito: respeita o que foi digitado, limitado ao que existe. Pedir
                 * mais do que há NÃO é erro — o plano entrega o possível e a tela mostra a falta,
                 * que é a informação que interessa.
                 */
                pedido = {};
                UNIDADES_DEFESA.forEach(function (u) {
                    var v = parseFloat(String(alvo.porTipo[u] || '').replace(',', '.'));
                    pedido[u] = (v > 0) ? Math.round(v * 1000) : 0;
                });
            } else {
                pedido = pedidoPorPop(alvo.popPedida, disp);
            }

            /*
             * Espião é por aldeia, não rateado: vai como olho junto do apoio. Fica fora do modo
             * "por tipo" de propósito — duas fontes para o mesmo número é receita de divergência.
             */
            pedido.spy = alvo.espioes * sel.elegiveis.length;

            var plano = montarPlano(sel.elegiveis, pedido, opcoes.comJanela);

            plano.forEach(function (p) {
                if (!gasto[p.id]) gasto[p.id] = {};
                Object.keys(p.envio).forEach(function (u) {
                    gasto[p.id][u] = (gasto[p.id][u] || 0) + (p.envio[u] || 0);
                });
            });

            var popEntregue = plano.reduce(function (s, p) { return s + p.pop; }, 0);

            saida.push({
                coord: alvo.coord, popPedida: alvo.popPedida, popEntregue: popEntregue,
                modo: alvo.modo, pedido: pedido,
                plano: plano, fora: sel.fora, comJanela: !!alvo.janela, janela: alvo.janela,
                aldeias: plano.length
            });
        });

        return { alvos: saida, agora: agora };
    }

    /* ------------------------------- preencher a tela do jogo ------------------------------ */

    /*
     * Escreve o plano nos campos do jogo. NÃO ENVIA — quem clica em "Enviar apoio" é você.
     *
     * Os campos nascem `disabled`; quem os habilita é o checkbox da linha
     * (`input.troop-request-selector[data-village-id]`). Por isso: marcar, disparar o evento pro
     * JS do jogo reagir, e só então escrever o valor.
     */
    function preencherTela(planoDoAlvo) {
        var mexidas = 0, naoAchadas = [];

        // limpa o que estiver preenchido, pra não somar com uma rodada anterior
        Array.from(document.querySelectorAll('input.call-unit-box')).forEach(function (i) {
            if (!i.disabled) i.value = '';
        });

        planoDoAlvo.plano.forEach(function (p) {
            var tr = document.querySelector('#call_village_' + p.id);
            if (!tr) { naoAchadas.push(p.coord); return; }

            var check = tr.querySelector('input.troop-request-selector');
            if (check && !check.checked) {
                check.checked = true;
                check.dispatchEvent(new Event('change', { bubbles: true }));
                if (window.jQuery) jQuery(check).trigger('change');
            }

            Object.keys(p.envio).forEach(function (u) {
                var q = p.envio[u] || 0;
                if (q <= 0) return;
                var campo = tr.querySelector('.call-unit-box-' + u);
                if (!campo) { return; }
                campo.disabled = false;
                campo.value = q;
                campo.dispatchEvent(new Event('input', { bubbles: true }));
                campo.dispatchEvent(new Event('change', { bubbles: true }));
                mexidas++;
            });
        });

        return { campos: mexidas, naoAchadas: naoAchadas };
    }

    /* ----------------------------------- envio direto ------------------------------------- */

    var ENVIANDO = false;      // trava contra dois envios ao mesmo tempo
    var CANCELAR = false;

    /*
     * Monta o corpo do POST de UM alvo. Nada aqui é inventado: são os mesmos campos que o
     * formulário do jogo manda quando você clica em "Enviar apoio".
     */
    function corpoDoEnvio(alvo) {
        var partes = String(alvo.coord).split('|');
        var corpo = new URLSearchParams();
        corpo.set('x', partes[0]);
        corpo.set('y', partes[1]);
        corpo.set('h', (window.game_data && game_data.csrf) || '');
        alvo.plano.forEach(function (p) {
            Object.keys(p.envio).forEach(function (u) {
                var q = p.envio[u] || 0;
                if (q > 0) corpo.set('call[' + p.id + '][' + u + ']', String(q));
            });
        });
        return corpo;
    }

    function urlDoEnvio() {
        var vid = (window.game_data && game_data.village && game_data.village.id) || '';
        return '/game.php?village=' + vid + '&screen=place&mode=call&action=call';
    }

    /*
     * Despacha um alvo e CONFERE a resposta.
     *
     * O que vale como falha: status HTTP ruim, captcha, ou a caixa de erro do próprio jogo. Na
     * dúvida, é falha — mandar tropa é irreversível o bastante pra que "não sei" seja tratado como
     * "deu errado" e a fila PARE, em vez de seguir no escuro.
     */
    async function enviarAlvo(alvo) {
        var resp;
        try {
            resp = await fetch(urlDoEnvio(), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: corpoDoEnvio(alvo).toString()
            });
        } catch (e) {
            return { ok: false, motivo: 'a requisição não completou (' + (e && e.message ? e.message : e) + ')' };
        }

        if (!resp.ok) return { ok: false, motivo: 'o servidor respondeu ' + resp.status };

        var html = '';
        try { html = await resp.text(); } catch (e) { html = ''; }

        if (/bot_check|botprotection|hcaptcha|g-recaptcha/i.test(html)) {
            return { ok: false, motivo: 'apareceu verificação de robô — resolva no jogo antes de continuar', captcha: true };
        }

        /*
         * A caixa de erro do TW. Procuro a CLASSE, não a palavra "erro" solta no texto: a página
         * tem menus e avisos que contêm essa palavra sem nenhum erro ter acontecido.
         */
        var mErro = html.match(/class="error_box"[^>]*>([\s\S]{0,300}?)<\/div>/i);
        if (mErro) {
            var limpo = mErro[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            return { ok: false, motivo: limpo || 'o jogo recusou o envio' };
        }

        return { ok: true };
    }

    /*
     * DESPACHA TODOS OS ALVOS, um por vez.
     *
     * Sequencial de propósito: em paralelo, um erro no meio deixaria o resto voando sem ninguém
     * saber o que chegou a sair. Aqui, o primeiro erro PARA a fila e o painel mostra exatamente
     * onde parou — o que já foi está feito, o que faltava não foi tentado.
     *
     * A pausa entre alvos não é superstição: é uma rajada de POSTs idênticos que o servidor
     * enxerga, e espaçar mantém o comportamento parecido com o de alguém clicando.
     */
    async function enviarTudo(resultado) {
        if (ENVIANDO) return;
        ENVIANDO = true;
        CANCELAR = false;

        var comPlano = resultado.alvos.filter(function (a) { return a.plano.length > 0; });
        var feitos = [], parou = null;

        try {
            for (var i = 0; i < comPlano.length; i++) {
                if (CANCELAR) { parou = { alvo: comPlano[i].coord, motivo: 'cancelado por você' }; break; }

                var a = comPlano[i];
                mostrarProgresso(i, comPlano.length, a.coord, feitos, null);

                var r = await enviarAlvo(a);
                if (!r.ok) { parou = { alvo: a.coord, motivo: r.motivo, captcha: r.captcha }; break; }

                feitos.push({ coord: a.coord, aldeias: a.plano.length, pop: a.popEntregue });

                if (i < comPlano.length - 1) {
                    await new Promise(function (ok) { setTimeout(ok, 400 + Math.floor(300 * ((i % 3) / 3))); });
                }
            }
        } finally {
            ENVIANDO = false;
        }

        mostrarProgresso(comPlano.length, comPlano.length, null, feitos, parou);

        /*
         * Depois de enviar, a tela está VELHA: as tropas que saíram ainda aparecem na tabela.
         * Recarregar é o que devolve a verdade — e o plano continua salvo, então nada se perde.
         */
        if (feitos.length && !parou) {
            setTimeout(function () { location.reload(); }, 2500);
        }
    }

    function mostrarProgresso(feitosN, total, atual, feitos, parou) {
        var cx = document.getElementById('apm-progresso');
        if (!cx) return;
        var html = '';

        if (atual) {
            html += '<div class="apm-aviso">Enviando ' + (feitosN + 1) + ' de ' + total + ' — alvo ' +
                    esc(atual) + '… <button class="apm-bt" id="apm-cancelar">Parar</button></div>';
        }

        if (feitos.length) {
            html += '<div class="apm-ok-box"><b>Enviado:</b> ' +
                feitos.map(function (f) {
                    return esc(f.coord) + ' (' + f.aldeias + ' aldeias, ' + nf(Math.round(f.pop / 1000)) + 'k)';
                }).join(' · ') + '</div>';
        }

        if (parou) {
            html += '<div class="apm-erro"><b>PAREI no alvo ' + esc(parou.alvo) + ':</b> ' + esc(parou.motivo) +
                    '\n' + (feitos.length ? 'Os ' + feitos.length + ' alvo(s) acima JÁ FORAM enviados. ' : 'Nada foi enviado. ') +
                    'Os alvos seguintes não foram tentados — confira a tela e recalcule.</div>';
        } else if (!atual && feitos.length) {
            html += '<div class="apm-aviso">Tudo enviado. Recarregando a tela pra atualizar as tropas…</div>';
        }

        cx.innerHTML = html;
        var bt = document.getElementById('apm-cancelar');
        if (bt) bt.onclick = function () { CANCELAR = true; bt.disabled = true; bt.textContent = 'parando…'; };
    }

    /*
     * O texto da confirmação. É a última barreira antes de tropa sair, então diz TUDO: alvos,
     * aldeias, tropa por tipo e o que está faltando — sem eufemismo.
     */
    function textoDaConfirmacao(resultado) {
        var comPlano = resultado.alvos.filter(function (a) { return a.plano.length > 0; });
        var totalUn = {}, totalAldeias = 0, totalPop = 0;
        UNIDADES_DEFESA.forEach(function (u) { totalUn[u] = 0; });

        comPlano.forEach(function (a) {
            totalAldeias += a.plano.length;
            totalPop += a.popEntregue;
            a.plano.forEach(function (p) {
                UNIDADES_DEFESA.forEach(function (u) { totalUn[u] += p.envio[u] || 0; });
            });
        });

        var linhas = ['ENVIAR APOIO DE VERDADE', ''];
        comPlano.forEach(function (a, i) {
            linhas.push('  ' + (i + 1) + '. ' + a.coord + ' — ' + a.plano.length + ' aldeia(s), ' +
                        nf(Math.round(a.popEntregue / 1000)) + 'k de pop' +
                        (a.faltando || (a.popPedida - a.popEntregue > 500)
                            ? '  (FALTANDO ' + nf(Math.round((a.popPedida - a.popEntregue) / 1000)) + 'k)' : ''));
        });

        linhas.push('');
        linhas.push('Total: ' + comPlano.length + ' alvo(s), ' + totalAldeias + ' envio(s), ' +
                    nf(Math.round(totalPop / 1000)) + 'k de pop');
        linhas.push('Tropa: ' + UNIDADES_DEFESA.filter(function (u) { return totalUn[u] > 0; })
            .map(function (u) { return nf(totalUn[u]) + ' ' + UN_PT[u]; }).join(' · '));

        var faltando = resultado.alvos.filter(function (a) { return (a.popPedida - a.popEntregue) > 500; });
        if (faltando.length) {
            linhas.push('');
            linhas.push('ATENÇÃO: ' + faltando.length + ' alvo(s) NÃO recebem o que você pediu, por falta de');
            linhas.push('tropa: ' + faltando.map(function (a) { return a.coord; }).join(', ') + '.');
            linhas.push('Vai ser enviado o que existe. Cancele se quiser refazer o plano.');
        }

        var semPlano = resultado.alvos.filter(function (a) { return !a.plano.length; });
        if (semPlano.length) {
            linhas.push('');
            linhas.push('Sem nada a enviar (ficam de fora): ' +
                        semPlano.map(function (a) { return a.coord; }).join(', '));
        }

        linhas.push('');
        linhas.push('O envio é IMEDIATO e não tem desfazer. Confirmar?');
        return linhas.join('\n');
    }

    /* Troca o alvo da tela usando o formulário do próprio jogo (o "Alterar"). */
    function irParaAlvo(coord) {
        var partes = String(coord).split('|');
        var x = document.querySelector('#inputx'), y = document.querySelector('#inputy');
        if (!x || !y || partes.length !== 2) { avisar('Não achei os campos de coordenada desta tela.', 'erro'); return; }
        x.value = partes[0];
        y.value = partes[1];
        var form = x.form || y.form;
        if (!form) { avisar('Troque a coordenada à mão e clique em Alterar.', 'erro'); return; }
        form.submit();
    }

    /* ---------------------------------------- painel --------------------------------------- */

    var CSS = [
        /* ---- janela ---- */
        '#apm-painel{position:fixed;z-index:12000;width:700px;max-width:96vw;background:#2b2116;',
        '  border:1px solid #8a5c14;border-radius:7px;color:#e8dcc0;font:12px Verdana,sans-serif;',
        '  box-shadow:0 10px 34px rgba(0,0,0,.55)}',
        '#apm-cab{background:linear-gradient(#5b4620,#42320f);padding:7px 10px;cursor:move;',
        '  display:flex;align-items:center;gap:10px;border-bottom:1px solid #8a5c14;',
        '  border-radius:6px 6px 0 0}',
        '#apm-cab b{flex:1;font-size:13px;letter-spacing:.4px;color:#f5e3b8}',
        '#apm-cab a{color:#cbb88c;text-decoration:none;padding:1px 6px;font-weight:bold;border-radius:3px}',
        '#apm-cab a:hover{background:rgba(255,255,255,.12);color:#fff}',
        '#apm-corpo{padding:10px 12px 12px;max-height:72vh;overflow:auto}',

        /* ---- seções ---- */
        '.apm-sec{margin-bottom:12px}',
        '.apm-sec>h4{margin:0 0 6px;font-size:11px;letter-spacing:.8px;text-transform:uppercase;',
        '  color:#d9a441;border-bottom:1px solid #5a4520;padding-bottom:4px;font-weight:bold}',

        /* ---- tabelas ---- */
        /*
         * O jogo tem regras próprias e específicas para th/td (a folha do TW mira `.vis th`,
         * `#content_value table th` e afins). Sem classe própria + !important nas cores, o
         * cabeçalho do painel herdava o bege do jogo e sumia o texto.
         */
        '#apm-painel table.apm-t{width:100%;border-collapse:collapse;background:transparent!important}',
        '#apm-painel table.apm-t th{background:#3b2d17!important;padding:5px 6px!important;',
        '  text-align:left!important;font-size:10px!important;letter-spacing:.5px;',
        '  text-transform:uppercase;color:#d9a441!important;font-weight:bold!important;',
        '  border:0!important;border-bottom:1px solid #5a4520!important;text-shadow:none!important}',
        '#apm-painel table.apm-t td{padding:6px!important;background:transparent!important;',
        '  border:0!important;border-bottom:1px solid #3d2f1c!important;vertical-align:top;',
        '  color:#e8dcc0!important;font-size:11px!important;text-shadow:none!important}',
        '#apm-painel table.apm-t tr{background:transparent!important}',
        '#apm-painel table.apm-t tr:last-child td{border-bottom:0!important}',

        /* ---- campos ---- */
        '#apm-painel input[type=text],#apm-painel input[type=number],#apm-painel select{',
        '  background:#191309;color:#f0e6cd;border:1px solid #6b4a14;border-radius:3px;',
        '  padding:3px 5px;font:11px Verdana,sans-serif;transition:border-color .12s}',
        '#apm-painel input:focus,#apm-painel select:focus{outline:0;border-color:#d9a441;',
        '  box-shadow:0 0 0 2px rgba(217,164,65,.18)}',
        '#apm-painel input::placeholder{color:#6f6349}',
        '#apm-painel input.apm-coord{width:74px;font-weight:bold}',
        '#apm-painel input.apm-pop{width:58px;text-align:right;font-variant-numeric:tabular-nums}',
        '#apm-painel input.apm-hora{width:88px;text-align:center}',
        '#apm-painel input.apm-res{width:56px;text-align:right;font-variant-numeric:tabular-nums}',
        '#apm-painel select{max-width:190px}',

        /* ---- botões ---- */
        '.apm-bt{background:linear-gradient(#5f4a22,#48360f);color:#f0e6cd;border:1px solid #8a5c14;',
        '  border-radius:3px;padding:4px 11px;cursor:pointer;font:bold 11px Verdana,sans-serif}',
        '.apm-bt:hover{background:linear-gradient(#6f5729,#564018)}',
        '.apm-bt.forte{background:linear-gradient(#3f7336,#2c5626);border-color:#5fa350}',
        '.apm-bt.forte:hover{background:linear-gradient(#4c8741,#36682e)}',
        '.apm-bt.perigo{background:linear-gradient(#7d3d22,#5d2c17);border-color:#b06438}',
        '.apm-bt.perigo:hover{background:linear-gradient(#94492a,#6f351c)}',
        '.apm-bt:disabled{opacity:.4;cursor:not-allowed;background:#3a2e1c}',
        '.apm-x{color:#c98080;cursor:pointer;font-weight:bold;padding:2px 5px;border-radius:3px}',
        '.apm-x:hover{background:rgba(201,128,128,.18);color:#ffb3b3}',

        /* ---- linha de alvo ---- */
        '.apm-linha-alvo td{vertical-align:top}',
        '.apm-num{color:#8f8264;font-weight:bold;font-size:13px;padding-top:4px}',
        '.apm-coord-cel{white-space:nowrap}',
        '.apm-portipo-caixa{display:grid;grid-template-columns:auto auto;gap:3px 6px;align-items:center}',
        '.apm-campo-rot{display:flex;align-items:center;gap:5px}',
        '.apm-tipo-rot{font-size:10px;color:#b3a380;text-align:right;white-space:nowrap}',
        '.apm-portipo-caixa input{width:58px}',
        '.apm-portipo-pe{grid-column:1/-1;font-size:10px;color:#8f8264;padding-top:2px}',
        '.apm-janela{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',

        /* ---- avisos ---- */
        '.apm-nota{font-size:10px;color:#9c8d6b;line-height:1.5}',
        '.apm-erro{background:#4a1d1d;border-left:3px solid #c25a5a;border-radius:3px;',
        '  padding:7px 9px;white-space:pre-wrap;color:#ffd9d9;margin-bottom:8px;font-size:11px}',
        '.apm-aviso{background:#463a15;border-left:3px solid #d9a441;border-radius:3px;',
        '  padding:7px 9px;color:#ffeaa8;margin-bottom:8px;font-size:11px}',
        '.apm-ok-box{background:#26401f;border-left:3px solid #5fa350;border-radius:3px;',
        '  padding:7px 9px;color:#cfe8c3;margin-bottom:8px;font-size:11px}',
        '.apm-falta{color:#f09a9a}',
        '.apm-ok{color:#9ad18b}',
        '.apm-aqui{background:#3f7336;color:#fff;border-radius:3px;padding:1px 6px;font-size:9px;',
        '  letter-spacing:.4px;text-transform:uppercase;font-weight:bold;vertical-align:middle}',
        'a.apm-modo{color:#7fb0d8;font-size:10px;text-decoration:none}',
        'a.apm-modo:hover{text-decoration:underline;color:#a6cdec}',
        'a.apm-det{color:#7fb0d8;font-size:10px;text-decoration:none}',
        'a.apm-det:hover{text-decoration:underline}',

        /* ---- orçamento ---- */
        '.apm-orc{background:#241b11;border:1px solid #5a4520;border-radius:4px;padding:8px 10px;',
        '  display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
        '.apm-orc b{color:#f0c674}',
        '.apm-fonte{background:#3b2d17;border:1px solid #5a4520;border-radius:3px;padding:2px 8px;',
        '  font-size:10px;color:#c9a35a}',
        '.apm-fonte b{color:#f5e3b8}',
        '.apm-unidades{flex-basis:100%;border-top:1px solid #3d2f1c;padding-top:6px;margin-top:2px}',
        '#apm-painel table.apm-tab-un{width:auto;border-collapse:collapse;background:transparent!important}',
        '#apm-painel table.apm-tab-un th{background:transparent!important;border:0!important;',
        '  padding:1px 0 3px 16px!important;text-align:right!important;font-size:10px!important;',
        '  color:#d9a441!important;text-shadow:none!important}',
        '#apm-painel table.apm-tab-un td{border:0!important;padding:2px 0 2px 16px!important;',
        '  text-align:right!important;font-size:11px!important;font-variant-numeric:tabular-nums;',
        '  vertical-align:middle;background:transparent!important;color:#e8dcc0!important}',
        '#apm-painel table.apm-tab-un td:first-child,#apm-painel table.apm-tab-un th:first-child{',
        '  text-align:left!important;padding-left:0!important;color:#8f8264!important;',
        '  font-size:10px!important;text-transform:uppercase;letter-spacing:.5px;min-width:46px}',
        '#apm-painel table.apm-tab-un tr:last-child td{border-top:1px solid #3d2f1c!important;',
        '  font-weight:bold}',
        '#apm-painel table.apm-tab-un td.apm-zero{color:#6f6349!important}',

        /* ---- resultado ---- */
        '#apm-resultado td{font-variant-numeric:tabular-nums;vertical-align:middle}',
        '#apm-detalhe{margin-top:8px}',
        '#apm-msg:empty{display:none}',
        '#apm-progresso:empty{display:none}',

        /* ---- botão minimizado ---- */
        '#apm-abrir{position:fixed;z-index:12000;background:linear-gradient(#5b4620,#42320f);',
        '  color:#f5e3b8;border:1px solid #8a5c14;border-radius:4px;padding:6px 12px;cursor:pointer;',
        '  font:bold 12px Verdana,sans-serif;box-shadow:0 3px 10px rgba(0,0,0,.4)}',
        '#apm-abrir:hover{background:linear-gradient(#6f5729,#564018)}',
        '#apm-abrir:active{cursor:grabbing}'
    ].join('');

    function injetarCSS() {
        if (document.getElementById('apm-css')) return;
        var s = document.createElement('style');
        s.id = 'apm-css';
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    function avisar(txt, tipo) {
        var m = document.getElementById('apm-msg');
        if (!m) { console.log('[Apoio em Massa]', txt); return; }
        m.className = tipo === 'erro' ? 'apm-erro' : 'apm-aviso';
        m.textContent = txt;
    }
    function limparAviso() {
        var m = document.getElementById('apm-msg');
        if (m) { m.textContent = ''; m.className = ''; }
    }

    /* ------------------------------------ desenho da tela ---------------------------------- */

    var ULTIMO = null;          // último cálculo, pra não recalcular ao preencher

    function desenhar() {
        injetarCSS();
        var velho = document.getElementById('apm-painel');
        var scroll = velho ? velho.querySelector('#apm-corpo').scrollTop : 0;
        if (velho) velho.remove();

        var atual = alvoAtual();
        var unidades = unidadesDoMundo().filter(function (u) { return POP_DEFESA[u] > 0; });

        var html = '<div id="apm-cab"><b>Apoio em Massa</b>' +
            '<a href="#" id="apm-min" title="Minimizar">—</a>' +
            '<a href="#" id="apm-fechar" title="Fechar">✕</a></div>' +
            '<div id="apm-corpo"><div id="apm-msg"></div>';

        /* ----- alvos ----- */
        html += '<div class="apm-sec"><h4>Alvos &mdash; a ordem é a prioridade</h4>' +
            '<table class="apm-t"><tr><th style="width:22px">#</th><th>Coordenada</th><th style="width:74px">Quero (k)</th>' +
            '<th style="width:46px" title="Espiões de CADA aldeia para este alvo. Vazio usa o padrão dos Ajustes.">Espiões</th>' +
            '<th style="width:210px">Chegar entre (hora do servidor)</th><th style="width:90px"></th><th style="width:20px"></th></tr>';

        if (!EST.alvos.length) {
            html += '<tr><td colspan="7" class="apm-nota">Nenhum alvo ainda. Clique em “+ alvo”.</td></tr>';
        }

        EST.alvos.forEach(function (a, i) {
            var ehAqui = atual && String(a.coord).trim() === atual;
            html += '<tr class="apm-linha-alvo" data-i="' + i + '">' +
                '<td class="apm-num">' + (i + 1) + '</td>' +
                '<td class="apm-coord-cel"><input type="text" class="apm-coord" data-campo="coord" value="' + esc(a.coord || '') + '" placeholder="500|500">' +
                    (ehAqui ? ' <span class="apm-aqui">esta tela</span>' : '') + '</td>' +
                '<td>' + celulaQuero(a, i) + '</td>' +
                '<td><div class="apm-campo-rot"><span class="apm-tipo-rot">Espiões</span>' +
                    '<input type="text" class="apm-res" data-campo="espioes" value="' + esc(a.espioes == null ? '' : a.espioes) +
                    '" placeholder="' + esc(EST.espioes || 0) + '" title="Espiões de CADA aldeia para este alvo. Vazio = padrão dos Ajustes."></div>' +
                    '<div class="apm-portipo-pe">por aldeia</div></td>' +
                '<td><div class="apm-janela">' +
                    '<input type="checkbox" data-campo="usarJanela"' + (a.usarJanela ? ' checked' : '') + ' title="Acertar a hora de chegada deste alvo">' +
                    '<input type="text" class="apm-hora" data-campo="inicio" value="' + esc(a.inicio || '') + '" placeholder="14:30"' + (a.usarJanela ? '' : ' disabled') + '>' +
                    '<span class="apm-nota">até</span>' +
                    '<input type="text" class="apm-hora" data-campo="fim" value="' + esc(a.fim || '') + '" placeholder="15:10"' + (a.usarJanela ? '' : ' disabled') + '>' +
                    '</div></td>' +
                '<td>' + (ehAqui ? '' : '<button class="apm-bt apm-ir" data-i="' + i + '">ir para cá</button>') + '</td>' +
                '<td><span class="apm-x apm-del" data-i="' + i + '" title="Remover">✕</span></td>' +
                '</tr>';
        });
        html += '</table>' +
            '<button class="apm-bt" id="apm-add">+ alvo</button> ' +
            '<button class="apm-bt" id="apm-add-aqui">+ esta tela' + (atual ? ' (' + esc(atual) + ')' : '') + '</button>' +
            '<div class="apm-nota">Hora do servidor. Só a hora (14:30) vale para hoje — se já passou, entende como amanhã.</div>' +
            '</div>';

        /* ----- ajustes ----- */
        html += '<div class="apm-sec"><h4>Ajustes</h4><table class="apm-t"><tr>' +
            '<td style="width:50%">Guardar em cada aldeia:<br>';
        unidades.forEach(function (u) {
            html += '<span style="margin-right:8px;display:inline-block">' + UN_PT[u] + ' ' +
                '<input type="text" class="apm-res" data-res="' + u + '" value="' + esc(EST.reserva[u] || 0) + '"></span>';
        });
        var grupos = gruposDaPagina();
        var gAtual = GRUPO_CARREGADO ? GRUPO_CARREGADO.id : grupoAtual();
        var selGrupo = '<select id="apm-grupo">' + grupos.map(function (g) {
            return '<option value="' + esc(g.id) + '"' + (g.id === gAtual ? ' selected' : '') + '>' +
                   esc(g.nome) + '</option>';
        }).join('') + '</select>';

        html += '</td><td>Espiões por aldeia <span class="apm-nota">(padrão)</span>: ' +
            '<input type="text" class="apm-res" id="apm-espioes" value="' + esc(EST.espioes || 0) + '" ' +
            'title="Vale para os alvos que deixarem o campo vazio">' +
            '<br>Distância máxima: <input type="text" class="apm-res" id="apm-dist" value="' + esc(EST.distanciaMax || '') + '" placeholder="sem limite"> campos' +
            '<br>Grupo de origem: ' + selGrupo +
            (grupos.length > 1 ? '' : ' <span class="apm-nota">(nenhum grupo nesta tela)</span>') +
            '</td></tr></table>' +
            '<div class="apm-nota">Trocar o grupo lê a lista daquele grupo em segundo plano, sem sair da tela. ' +
            'Se não der, recarrega — e avisa.</div>' +
            '</div>';

        html += '<div class="apm-sec">' +
            '<button class="apm-bt forte" id="apm-calc">Calcular plano</button> ' +
            '<button class="apm-bt perigo" id="apm-enviar" disabled>Enviar tudo</button> ' +
            '<button class="apm-bt" id="apm-preencher" disabled>Só preencher esta tela</button>' +
            '<div class="apm-nota" style="margin-top:4px">“Enviar tudo” despacha todos os alvos de uma vez, ' +
            'depois da sua confirmação. “Só preencher” escreve nos campos desta tela e deixa o clique final com você.</div>' +
            '</div>';

        html += '<div id="apm-progresso"></div><div id="apm-resultado"></div></div>';

        var div = document.createElement('div');
        div.id = 'apm-painel';
        div.innerHTML = html;
        document.body.appendChild(div);

        var pos = EST.pos || { left: 20, top: 60 };
        div.style.left = Math.max(0, Math.min(pos.left, window.innerWidth - 120)) + 'px';
        div.style.top = Math.max(0, Math.min(pos.top, window.innerHeight - 60)) + 'px';

        ligarEventos(div);
        div.querySelector('#apm-corpo').scrollTop = scroll;
        if (ULTIMO) mostrarResultado(ULTIMO);
        return div;
    }

    /*
     * A célula "Quero" tem dois rostos:
     *
     *   modo "pop"  -> um campo só, em milhares de POPULAÇÃO. O script reparte entre as tropas na
     *                  proporção do que existe. É o caminho rápido e serve na maioria das vezes.
     *   modo "tipo" -> um campo por tropa, também em milhares. Serve quando o alvo precisa de algo
     *                  específico (anti-cavalaria, por exemplo) ou quando você quer guardar um
     *                  tipo em casa.
     *
     * Nos dois casos o rodapé mostra a mesma coisa em pop, senão o orçamento perderia o sentido ao
     * misturar alvos dos dois jeitos.
     */
    function celulaQuero(a, i) {
        if (a.modo !== 'tipo') {
            return '<div class="apm-campo-rot"><span class="apm-tipo-rot">Pop (k)</span>' +
                   '<input type="text" class="apm-pop" data-campo="popK" value="' + esc(a.popK || '') +
                   '" placeholder="80"></div><div class="apm-portipo-pe">' +
                   '<a href="#" class="apm-modo" data-i="' + i +
                   '" title="Escolher tropa por tropa">por tipo</a></div>';
        }

        /*
         * Grade de duas colunas (rótulo à direita, campo à esquerda): com `flex-wrap` os rótulos
         * de larguras diferentes deixavam os campos em posições diferentes, e a coluna inteira
         * parecia torta.
         */
        var campos = unidadesDoMundo().filter(function (u) { return POP_DEFESA[u] > 0; })
            .map(function (u) {
                return '<span class="apm-tipo-rot">' + esc(UN_PT[u]) + '</span>' +
                       '<input type="text" class="apm-pop apm-portipo" data-tipo="' + u + '" value="' +
                       esc((a.porTipo || {})[u] || '') + '" placeholder="0">';
            }).join('');

        return '<div class="apm-portipo-caixa">' + campos +
               '<div class="apm-portipo-pe">em milhares &middot; <b>' +
               nf(Math.round(popPedidaDoAlvo(a) / 1000)) + 'k</b> de pop &middot; ' +
               '<a href="#" class="apm-modo" data-i="' + i + '" title="Voltar a pedir só o total">só o total</a></div></div>';
    }

    /*
     * Arraste de qualquer elemento por qualquer alça, guardando a posição na chave indicada.
     *
     * `ARRASTOU` vale além do mouseup de propósito: o clique dispara DEPOIS dele, e é assim que o
     * botão minimizado sabe que aquele clique foi o fim de um arraste, não um pedido de abrir.
     * Sem isso, ajustar a posição do botão abriria o painel toda vez.
     */
    var ARRASTOU = false;

    function arrastavel(el, alca, chavePos) {
        var mexendo = false, dx = 0, dy = 0, x0 = 0, y0 = 0;

        alca.addEventListener('mousedown', function (e) {
            if (e.target.tagName === 'A') return;      // links do cabeçalho continuam clicáveis
            if (e.button !== 0) return;
            mexendo = true;
            ARRASTOU = false;
            x0 = e.clientX; y0 = e.clientY;
            dx = e.clientX - el.offsetLeft;
            dy = e.clientY - el.offsetTop;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!mexendo) return;
            // só vira "arraste" depois de sair do lugar: tremida de mão continua sendo clique
            if (!ARRASTOU && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 5) return;
            ARRASTOU = true;
            el.style.left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 60)) + 'px';
            el.style.top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 30)) + 'px';
        });

        document.addEventListener('mouseup', function () {
            if (!mexendo) return;
            mexendo = false;
            if (!ARRASTOU) return;
            EST[chavePos] = { left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10) };
            gravarEstado();
        });
    }

    function ligarEventos(div) {
        arrastavel(div, div.querySelector('#apm-cab'), 'pos');

        div.querySelector('#apm-fechar').onclick = function (e) {
            e.preventDefault(); div.remove(); botaoAbrir();
        };
        div.querySelector('#apm-min').onclick = function (e) {
            e.preventDefault();
            EST.minimizado = true; gravarEstado();
            div.remove(); botaoAbrir();
        };

        div.querySelector('#apm-add').onclick = function () {
            EST.alvos.push({ coord: '', popK: '', usarJanela: false, inicio: '', fim: '' });
            gravarEstado(); desenhar();
        };
        div.querySelector('#apm-add-aqui').onclick = function () {
            var a = alvoAtual();
            if (!a) { avisar('Não consegui identificar a coordenada desta tela.', 'erro'); return; }
            EST.alvos.push({ coord: a, popK: '', usarJanela: false, inicio: '', fim: '' });
            gravarEstado(); desenhar();
        };

        Array.from(div.querySelectorAll('.apm-del')).forEach(function (x) {
            x.onclick = function () {
                EST.alvos.splice(+x.dataset.i, 1);
                ULTIMO = null;
                gravarEstado(); desenhar();
            };
        });
        Array.from(div.querySelectorAll('.apm-ir')).forEach(function (b) {
            b.onclick = function () {
                var a = EST.alvos[+b.dataset.i];
                if (a && a.coord) irParaAlvo(a.coord);
            };
        });

        /* campos dos alvos */
        Array.from(div.querySelectorAll('.apm-linha-alvo')).forEach(function (tr) {
            var i = +tr.dataset.i;
            Array.from(tr.querySelectorAll('[data-campo]')).forEach(function (el) {
                var campo = el.dataset.campo;
                var evento = el.type === 'checkbox' ? 'change' : 'input';
                el.addEventListener(evento, function () {
                    EST.alvos[i][campo] = (el.type === 'checkbox') ? el.checked : el.value;
                    gravarEstado();
                    if (campo === 'usarJanela') { desenhar(); return; }
                    atualizarOrcamento();
                });
            });
        });

        /* alternar entre "total" e "por tipo" */
        Array.from(div.querySelectorAll('.apm-modo')).forEach(function (a) {
            a.onclick = function (e) {
                e.preventDefault();
                var alvo = EST.alvos[+a.dataset.i];
                if (!alvo) return;
                if (alvo.modo === 'tipo') {
                    alvo.modo = 'pop';
                } else {
                    alvo.modo = 'tipo';
                    /*
                     * Ao abrir "por tipo" pela primeira vez, semeia com a repartição que o modo
                     * total faria — assim você ajusta a partir de algo pronto em vez de uma linha
                     * de campos vazios.
                     */
                    if (!alvo.porTipo || !Object.keys(alvo.porTipo).length) {
                        alvo.porTipo = semearPorTipo(alvo);
                    }
                }
                gravarEstado(); desenhar();
            };
        });

        Array.from(div.querySelectorAll('.apm-linha-alvo')).forEach(function (tr) {
            var i = +tr.dataset.i;
            Array.from(tr.querySelectorAll('.apm-portipo')).forEach(function (el) {
                el.addEventListener('input', function () {
                    if (!EST.alvos[i].porTipo) EST.alvos[i].porTipo = {};
                    EST.alvos[i].porTipo[el.dataset.tipo] = el.value;
                    gravarEstado();
                    atualizarOrcamento();
                    atualizarPopDaLinha(tr, EST.alvos[i]);
                });
            });
        });

        /* ajustes */
        Array.from(div.querySelectorAll('[data-res]')).forEach(function (el) {
            el.addEventListener('input', function () {
                var n = parseInt(el.value, 10);
                EST.reserva[el.dataset.res] = isNaN(n) ? 0 : Math.max(0, n);
                gravarEstado();
                atualizarOrcamento();   // a reserva muda o "Tem": o rodapé não pode ficar velho
            });
        });
        div.querySelector('#apm-espioes').addEventListener('input', function (e) {
            var n = parseInt(e.target.value, 10);
            EST.espioes = isNaN(n) ? 0 : Math.max(0, n);
            gravarEstado();
            atualizarOrcamento();
            /*
             * A dica dos campos por alvo mostra o padrão. Mudar o padrão sem atualizá-la deixaria
             * escrito um número que não vale mais — e é justo nos campos vazios, que são os que
             * herdam. Mexo só no placeholder pra não redesenhar e roubar o foco de quem digita.
             */
            Array.from(div.querySelectorAll('.apm-linha-alvo input[data-campo=espioes]'))
                .forEach(function (c) { c.placeholder = String(EST.espioes || 0); });
        });
        var selG = div.querySelector('#apm-grupo');
        if (selG) selG.addEventListener('change', async function () {
            var id = selG.value;
            var nome = selG.options[selG.selectedIndex].textContent;
            gravarEstado();

            // voltar ao grupo da própria tela é só largar o que foi buscado
            if (id === grupoAtual()) {
                GRUPO_CARREGADO = null;
                ULTIMO = null;
                avisar('Voltei para o grupo desta tela: ' + nome + '.');
                desenhar();
                return;
            }

            selG.disabled = true;
            avisar('Carregando as aldeias do grupo "' + nome + '"…');

            var r = await buscarAldeiasDoGrupo(id, nome);
            selG.disabled = false;

            if (r && r.captcha) {
                avisar('Apareceu verificação de robô. Resolva no jogo e tente de novo.', 'erro');
                selG.value = GRUPO_CARREGADO ? GRUPO_CARREGADO.id : grupoAtual();
                return;
            }
            if (!r) {
                /*
                 * Não conseguimos ler o grupo por fetch. Em vez de seguir com a lista errada (que
                 * é a da tela, de OUTRO grupo), recarrega — que é lento mas sempre funciona.
                 */
                avisar('Não consegui ler esse grupo em segundo plano; vou recarregar a tela.');
                setTimeout(function () { trocarGrupoRecarregando(id); }, 900);
                return;
            }

            GRUPO_CARREGADO = r;
            ULTIMO = null;                 // o plano velho era de outras aldeias
            limparAviso();
            desenhar();
        });

        div.querySelector('#apm-dist').addEventListener('input', function (e) {
            var n = parseFloat(String(e.target.value).replace(',', '.'));
            EST.distanciaMax = (isNaN(n) || n <= 0) ? null : n;
            gravarEstado();
            atualizarOrcamento();
        });

        div.querySelector('#apm-calc').onclick = function () {
            limparAviso();
            var r = calcular();
            if (r.erro) { ULTIMO = null; avisar(r.erro, 'erro'); mostrarResultado(null); return; }
            ULTIMO = r;
            mostrarResultado(r);
        };

        div.querySelector('#apm-enviar').onclick = function () {
            if (!ULTIMO || ENVIANDO) return;
            var comPlano = ULTIMO.alvos.filter(function (a) { return a.plano.length > 0; });
            if (!comPlano.length) { avisar('Não há nada a enviar em nenhum alvo.', 'erro'); return; }
            if (!window.confirm(textoDaConfirmacao(ULTIMO))) return;
            limparAviso();
            enviarTudo(ULTIMO);
        };

        div.querySelector('#apm-preencher').onclick = function () {
            if (!ULTIMO) return;
            var atual = alvoAtual();
            var alvo = ULTIMO.alvos.filter(function (a) { return a.coord === atual; })[0];
            if (!alvo) { avisar('Esta tela (' + atual + ') não está na lista de alvos.', 'erro'); return; }
            if (!alvo.plano.length) { avisar('Não há nada a enviar para este alvo.', 'erro'); return; }

            var res = preencherTela(alvo);
            var msg = 'Preenchi ' + res.campos + ' campo(s) em ' + alvo.plano.length + ' aldeia(s). ' +
                      'Confira e clique em “Enviar apoio” — eu não envio por você.';
            if (res.naoAchadas.length) {
                msg += '\nNÃO achei na tela: ' + res.naoAchadas.join(', ') + ' (recalcule).';
                avisar(msg, 'erro');
            } else {
                avisar(msg);
            }
        };

        atualizarOrcamento();
    }

    /*
     * Reparte a pop que já estava pedida entre as tropas disponíveis, para o modo "por tipo"
     * começar preenchido em vez de vazio. Usa o mesmo `pedidoPorPop` do cálculo, então o que
     * aparece é exatamente o que o modo total teria feito.
     */
    function semearPorTipo(alvo) {
        var aldeias = (lerAldeias() || []).filter(function (a) { return !a.erroLeitura; });
        var livre = {};
        UNIDADES_DEFESA.forEach(function (u) {
            livre[u] = aldeias.reduce(function (soma, a) {
                return soma + Math.max(0, (a.tropas[u] || 0) - (EST.reserva[u] || 0));
            }, 0);
        });
        var popK = parseFloat(String(alvo.popK).replace(',', '.'));
        if (!(popK > 0)) return {};

        var pedido = pedidoPorPop(popK * 1000, livre);
        var saida = {};
        UNIDADES_DEFESA.forEach(function (u) {
            if (!POP_DEFESA[u]) return;
            if (pedido[u] > 0) saida[u] = (pedido[u] / 1000).toFixed(pedido[u] >= 1000 ? 1 : 2);
        });
        return saida;
    }

    /* Atualiza só o "Xk de pop" da linha, sem redesenhar o painel (o foco do campo se perderia). */
    function atualizarPopDaLinha(tr, alvo) {
        var b = tr.querySelector('.apm-portipo-pe b');
        if (b) b.textContent = nf(Math.round(popPedidaDoAlvo(alvo) / 1000)) + 'k';
    }

    /*
     * O ORÇAMENTO — o que você pediu: soma do que foi digitado nos alvos e compara com o que
     * existe de verdade. Atualiza a cada tecla, ANTES de calcular qualquer plano, pra você ver na
     * hora se a conta fecha.
     */
    function atualizarOrcamento() {
        var div = document.getElementById('apm-painel');
        if (!div) return;
        var alvo = document.getElementById('apm-orcamento');
        if (!alvo) {
            alvo = document.createElement('div');
            alvo.id = 'apm-orcamento';
            alvo.className = 'apm-orc';
            alvo.style.marginBottom = '8px';
            var sec = div.querySelector('#apm-resultado');
            sec.parentNode.insertBefore(alvo, sec);
        }

        var aldeias = lerAldeias() || [];
        var boas = aldeias.filter(function (a) { return !a.erroLeitura; });
        var ilegiveis = aldeias.length - boas.length;

        /*
         * Livre por UNIDADE, não só o total: é o número que decide se dá pra pedir o que se quer.
         * "217k disponível" esconde que 200k são lança e 17k são CP — e a diferença importa quando
         * o alvo precisa de anti-cavalaria.
         */
        var livre = {}, popTotal = 0;
        UNIDADES_DEFESA.forEach(function (u) { livre[u] = 0; });
        boas.forEach(function (a) {
            UNIDADES_DEFESA.forEach(function (u) {
                var guardar = EST.reserva[u] || 0;
                var sobra = Math.max(0, (a.tropas[u] || 0) - guardar);
                livre[u] += sobra;
                popTotal += sobra * (POP_DEFESA[u] || 0);
            });
        });

        var pedido = 0;
        EST.alvos.forEach(function (a) { pedido += popPedidaDoAlvo(a); });

        var sobra = popTotal - pedido;

        /*
         * Soma o pedido de TODOS os alvos, tropa a tropa. No modo "pop" a repartição depende do
         * que está livre, então os dois modos são resolvidos aqui pelo mesmo caminho do cálculo —
         * o rodapé não pode divergir do plano.
         */
        var pedidoUn = {};
        UNIDADES_DEFESA.forEach(function (u) { pedidoUn[u] = 0; });
        EST.alvos.forEach(function (a) {
            var p = pedidoPorUnidadeDoAlvo(a, livre);
            UNIDADES_DEFESA.forEach(function (u) { pedidoUn[u] += p[u] || 0; });
        });

        var unsDefesa = unidadesDoMundo().filter(function (u) { return POP_DEFESA[u] > 0; });

        /*
         * Espião é "tantos POR ALDEIA", então o total depende de quantas aldeias o alvo ALCANÇA —
         * não de quantas existem na tela. Aqui roda a mesma seleção do cálculo (distância, reserva,
         * janela) pra cada alvo, senão o rodapé anuncia espião que não vai sair.
         */
        var agoraServidor = agoraDoServidor();
        var alcance = [];              // quantas aldeias cada alvo alcança
        var espioesTotal = 0;

        EST.alvos.forEach(function (a) {
            var janela = null;
            if (a.usarJanela) {
                var ini = lerMomento(a.inicio, agoraServidor);
                var fim = lerMomento(a.fim, agoraServidor);
                if (ini !== null && fim !== null && fim > ini) janela = { agora: agoraServidor, inicio: ini, fim: fim };
            }
            var sel = selecionarAldeias(aldeias, {
                distanciaMax: EST.distanciaMax, reserva: EST.reserva,
                comJanela: !!janela, janela: janela || { agora: agoraServidor }
            });
            alcance.push(sel.elegiveis.length);
            espioesTotal += espioesDoAlvo(a) * sel.elegiveis.length;
        });

        var cab = '<tr><th></th>' + unsDefesa.map(function (u) {
            return '<th>' + esc(UN_PT[u]) + '</th>';
        }).join('') + '<th title="Vão como olho, sem valor de defesa">Espião</th></tr>';

        var lDisp = '<tr><td>Tem</td>' + unsDefesa.map(function (u) {
            return '<td>' + nf(livre[u]) + '</td>';
        }).join('') + '<td>' + nf(livre.spy || 0) + '</td></tr>';

        /*
         * Zero aparece como "0", não como "·". O ponto poupava tinta e custava clareza: na tela do
         * dono o espião ficava com um ponto onde deveria estar um número, e "não vai espião
         * nenhum" virava "não sei o que isso quer dizer".
         */
        var lPed = '<tr><td>Vai</td>' + unsDefesa.map(function (u) {
            var falta = pedidoUn[u] > livre[u];
            return '<td class="' + (falta ? 'apm-falta' : (pedidoUn[u] ? '' : 'apm-zero')) + '">' +
                   nf(pedidoUn[u]) + '</td>';
        }).join('') + '<td class="' + (espioesTotal ? '' : 'apm-zero') + '">' + nf(espioesTotal) + '</td></tr>';

        var lSobra = '<tr><td>Sobra</td>' + unsDefesa.map(function (u) {
            var resto = livre[u] - pedidoUn[u];
            return '<td class="' + (resto < 0 ? 'apm-falta' : 'apm-ok') + '"><b>' +
                   (resto < 0 ? '-' + nf(-resto) : nf(resto)) + '</b></td>';
        }).join('') + '<td>' + nf(Math.max(0, (livre.spy || 0) - espioesTotal)) + '</td></tr>';

        var estourou = unsDefesa.filter(function (u) { return pedidoUn[u] > livre[u]; })
                                .map(function (u) { return UN_PT[u]; });

        /*
         * De qual grupo são estas aldeias. Sem isto, o painel mostra números de um grupo enquanto a
         * tabela do jogo, atrás, mostra outro — e não há nada na tela dizendo qual é qual.
         */
        var deOndeVem = GRUPO_CARREGADO
            ? '<span class="apm-fonte">grupo <b>' + esc(GRUPO_CARREGADO.nome) + '</b> (lido agora)</span>'
            : '<span class="apm-fonte">grupo <b>' + esc(nomeDoGrupoAtual()) + '</b> (o desta tela)</span>';

        alvo.innerHTML = deOndeVem +
            '<span>Disponível: <b>' + nf(Math.round(popTotal / 1000)) + 'k</b></span>' +
            '<span>Pedido: <b>' + nf(Math.round(pedido / 1000)) + 'k</b></span>' +
            '<span class="' + (sobra < 0 ? 'apm-falta' : 'apm-ok') + '">' +
                (sobra < 0 ? 'FALTAM ' + nf(Math.round(-sobra / 1000)) + 'k' : 'sobra ' + nf(Math.round(sobra / 1000)) + 'k') +
            '</span>' +
            '<span class="apm-nota">' + boas.length + ' aldeia(s) na lista' +
                (ilegiveis ? ' · <span class="apm-falta">' + ilegiveis + ' ilegível(is)</span>' : '') +
                (alcance.length
                    ? ' · alcançam o alvo: ' + alcance.map(function (q, i) {
                          return '<b class="' + (q ? '' : 'apm-falta') + '">' + q + '</b>';
                      }).join(' / ')
                    : '') + '</span>' +
            '<div class="apm-unidades"><table class="apm-tab-un apm-t2">' + cab + lDisp + lPed + lSobra + '</table>' +
            (estourou.length
                ? '<div class="apm-falta" style="margin-top:4px">Não dá: falta ' + estourou.join(' e ') +
                  '. O plano entrega o que houver e mostra a falta por alvo.</div>'
                : '') +
            '</div>';
    }

    /* --------------------------------- resultado do cálculo -------------------------------- */

    function mostrarResultado(r) {
        var caixa = document.getElementById('apm-resultado');
        if (!caixa) return;
        var bt = document.getElementById('apm-preencher');
        var btEnv = document.getElementById('apm-enviar');
        if (!r) {
            caixa.innerHTML = '';
            if (bt) bt.disabled = true;
            if (btEnv) btEnv.disabled = true;
            return;
        }
        if (btEnv) btEnv.disabled = !r.alvos.some(function (a) { return a.plano.length > 0; });

        var atual = alvoAtual();
        var temAqui = r.alvos.some(function (a) { return a.coord === atual && a.plano.length; });
        if (bt) bt.disabled = !temAqui;

        var html = '<div class="apm-sec"><h4>Plano</h4>';
        html += '<table class="apm-t"><tr><th>#</th><th>Alvo</th><th>Aldeias</th><th>Vai</th><th>Ritmo</th><th>Chega</th><th></th></tr>';

        r.alvos.forEach(function (a, i) {
            var ehAqui = a.coord === atual;
            var falta = a.popPedida - a.popEntregue;
            var ritmos = {};
            a.plano.forEach(function (p) { ritmos[p.unidadeDeRitmo] = (ritmos[p.unidadeDeRitmo] || 0) + 1; });
            var ritmoTxt = Object.keys(ritmos).map(function (u) {
                return (UN_PT[u] || u) + (a.plano.length > 1 ? ' ×' + ritmos[u] : '');
            }).join(', ') || '—';

            var chegadas = a.plano.map(function (p) { return p.chegada; }).filter(Boolean);
            var chegaTxt = chegadas.length
                ? (hhmm(Math.min.apply(null, chegadas)) + (chegadas.length > 1 ? ' – ' + hhmm(Math.max.apply(null, chegadas)) : ''))
                : '—';

            html += '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td>' + esc(a.coord) + (ehAqui ? ' <span class="apm-aqui">aqui</span>' : '') + '</td>' +
                '<td>' + a.aldeias + '</td>' +
                '<td>' + nf(Math.round(a.popEntregue / 1000)) + 'k' +
                    (a.modo === 'tipo' ? ' <span class="apm-nota">(por tipo)</span>' : '') +
                    (falta > 500 ? ' <span class="apm-falta">(faltam ' + nf(Math.round(falta / 1000)) + 'k)</span>' : '') + '</td>' +
                '<td>' + esc(ritmoTxt) + '</td>' +
                '<td>' + chegaTxt + '</td>' +
                '<td><a href="#" class="apm-det" data-i="' + i + '">detalhe</a></td>' +
                '</tr>';
        });
        html += '</table><div id="apm-detalhe"></div></div>';

        caixa.innerHTML = html;
        Array.from(caixa.querySelectorAll('.apm-det')).forEach(function (a) {
            a.onclick = function (e) { e.preventDefault(); detalharAlvo(r.alvos[+a.dataset.i]); };
        });
    }

    function detalharAlvo(a) {
        var d = document.getElementById('apm-detalhe');
        if (!d) return;
        var unidades = unidadesDoMundo();

        var html = '<h4 style="margin-top:8px">Alvo ' + esc(a.coord) + '</h4><table class="apm-t">' +
            '<tr><th>Aldeia</th><th>Dist</th>' +
            unidades.map(function (u) { return '<th>' + UN_PT[u] + '</th>'; }).join('') +
            '<th>Aríete</th><th>Ritmo</th><th>Chega</th></tr>';

        a.plano.forEach(function (p) {
            html += '<tr><td>' + esc(p.coord) + '</td><td>' + (p.distancia || 0).toFixed(1) + '</td>' +
                unidades.map(function (u) { return '<td>' + (p.envio[u] ? nf(p.envio[u]) : '·') + '</td>'; }).join('') +
                '<td>' + ((p.envio.ram || p.envio.catapult) ? '1' : '·') + '</td>' +
                '<td>' + esc(UN_PT[p.unidadeDeRitmo] || p.unidadeDeRitmo) + '</td>' +
                '<td>' + (p.chegada ? hhmm(p.chegada) : '—') + '</td></tr>';
        });
        html += '</table>';

        /*
         * Quem ficou de fora e por quê. É o ponto em que o original era mudo: aldeia excluída
         * simplesmente sumia, e "não tenho tropa" ficava igual a "não consegui ler".
         */
        if (a.fora.length) {
            html += '<div class="apm-nota" style="margin-top:6px"><b>Fora deste alvo (' + a.fora.length + '):</b><br>' +
                a.fora.slice(0, 40).map(function (f) { return esc(f.coord) + ' — ' + esc(f.motivo); }).join('<br>') +
                (a.fora.length > 40 ? '<br>… e mais ' + (a.fora.length - 40) : '') + '</div>';
        }
        d.innerHTML = html;
    }

    function botaoAbrir() {
        injetarCSS();
        if (document.getElementById('apm-abrir')) return;
        var b = document.createElement('button');
        b.id = 'apm-abrir';
        b.textContent = 'Apoio em Massa';
        b.title = 'Clique para abrir · arraste para mudar de lugar';

        // posição PRÓPRIA: mover o botão não pode arrastar o painel junto
        var pos = EST.posBt || { left: 20, top: 60 };
        b.style.left = Math.max(0, Math.min(pos.left, window.innerWidth - 60)) + 'px';
        b.style.top = Math.max(0, Math.min(pos.top, window.innerHeight - 30)) + 'px';

        b.onclick = function () {
            if (ARRASTOU) { ARRASTOU = false; return; }   // isso foi o fim de um arraste
            b.remove();
            EST.minimizado = false; gravarEstado();
            desenhar();
        };

        document.body.appendChild(b);
        arrastavel(b, b, 'posBt');      // a alça é o próprio botão
    }

    /* ------------------------------------------ início ------------------------------------- */

    /*
     * MARCA INVISÍVEL — é por ela que o Gerenciador sabe que o script já rodou.
     *
     * Detectar pelo painel (#apm-painel) não serve: quando você minimiza, o painel deixa de
     * existir e o Gerenciador acha que a injeção falhou, reinjetando em laço. Foi exatamente o
     * que aconteceu com o Caçador de Torres no modo mapa. A marca existe sempre, minimizado ou
     * não, e some junto com a página.
     */
    if (!document.getElementById('apm-marca')) {
        var marca = document.createElement('div');
        marca.id = 'apm-marca';
        marca.style.display = 'none';
        document.body.appendChild(marca);
    }

    if (EST.minimizado) botaoAbrir(); else desenhar();

    console.log('[Apoio em Massa] pronto.');
})();
