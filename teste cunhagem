/*
 * Script Name: Mint Helper + Projeção de Nobres
 * Version: v1.2.0 (adaptado)
 * Base: Mint Helper v1.1.2 by RedAlert (https://twscripts.dev/)
 * Adaptação: cálculo de moedas cunháveis (estoque + transportes a caminho)
 *            + projeção de até qual "Limite de Nobres" isso te leva.
 */

// User Input
if (typeof DEBUG !== 'boolean') DEBUG = false;
if (typeof SECONDS_ALARM === 'undefined') SECONDS_ALARM = 10;

// Script Config
var scriptConfig = {
    scriptData: {
        prefix: 'mintHelperProjecao',
        name: 'Mint Helper + Projeção de Nobres',
        version: 'v1.2.0',
        author: 'RedAlert (adaptado)',
        authorUrl: 'https://twscripts.dev/',
        helpLink:
            'https://forum.tribalwars.net/index.php?threads/mint-helper.289685/',
    },
    translations: {
        pt_BR: {
            'Mint Helper + Projeção de Nobres': 'Mint Helper + Projeção de Nobres',
            Help: 'Ajuda',
            'Redirecting...': 'Redirecionando...',
            'There was an error!': 'Ocorreu um erro!',
            'Incoming Resources': 'Recursos a Caminho',
            'Last transport arrives at': 'Último transporte chega às',
            'Max. coins that can be minted': 'Máx. de moedas cunháveis',
            'Warehouse will become full in': 'Armazém ficará cheio em',
            'Full in: ': 'Cheio em: ',
            'Center Village': 'Aldeia Central',
            'Average Distance': 'Distância Média',
            'Warehouse is full!': 'Armazém cheio!',
            'Total Wood': 'Madeira Total',
            'Total Stone': 'Argila Total',
            'Total Iron': 'Ferro Total',
            'Avg. Wood': 'Média Madeira',
            'Avg. Stone': 'Média Argila',
            'Avg. Iron': 'Média Ferro',
            'Available Merchants': 'Mercadores Disponíveis',
            'Total Merchants': 'Mercadores Totais',
            'Noble Limit Projection': 'Projeção de Limite de Nobres',
            'Current noble limit': 'Limite atual de nobres',
            'Coins already saved for next limit': 'Moedas já guardadas p/ próximo limite',
            'Coins still needed for next limit': 'Moedas faltando p/ próximo limite',
            'Mintable coins (stock + incoming)': 'Moedas cunháveis (estoque + a caminho)',
            'Projected noble limit': 'Limite de nobres projetado',
            'Limits to be gained': 'Limites a serem alcançados',
            'Saved for next limit after this': 'Guardado p/ próximo limite depois disso',
            'Still missing for next limit after this': 'Ainda falta p/ próximo limite depois disso',
            'Noble panel not found on this page': 'Painel de moedas de ouro não encontrado nesta tela',
        },
        en_DK: {
            'Mint Helper + Projeção de Nobres': 'Mint Helper + Noble Projection',
            Help: 'Help',
            'Redirecting...': 'Redirecting...',
            'There was an error!': 'There was an error!',
            'Incoming Resources': 'Incoming Resources',
            'Last transport arrives at': 'Last transport arrives at',
            'Max. coins that can be minted': 'Max. coins that can be minted',
            'Warehouse will become full in': 'Warehouse will become full in',
            'Full in: ': 'Full in: ',
            'Center Village': 'Center Village',
            'Average Distance': 'Average Distance',
            'Warehouse is full!': 'Warehouse is full!',
            'Total Wood': 'Total Wood',
            'Total Stone': 'Total Stone',
            'Total Iron': 'Total Iron',
            'Avg. Wood': 'Avg. Wood',
            'Avg. Stone': 'Avg. Stone',
            'Avg. Iron': 'Avg. Iron',
            'Available Merchants': 'Available Merchants',
            'Total Merchants': 'Total Merchants',
            'Noble Limit Projection': 'Noble Limit Projection',
            'Current noble limit': 'Current noble limit',
            'Coins already saved for next limit': 'Coins already saved for next limit',
            'Coins still needed for next limit': 'Coins still needed for next limit',
            'Mintable coins (stock + incoming)': 'Mintable coins (stock + incoming)',
            'Projected noble limit': 'Projected noble limit',
            'Limits to be gained': 'Limits to be gained',
            'Saved for next limit after this': 'Saved for next limit after this',
            'Still missing for next limit after this': 'Still missing for next limit after this',
            'Noble panel not found on this page': 'Noble panel not found on this page',
        },
    },
    allowedMarkets: [],
    allowedScreens: [],
    allowedModes: [],
    isDebug: DEBUG,
    enableCountApi: true,
};

window.twSDK = {
    // variables
    scriptData: {},
    translations: {},
    allowedMarkets: [],
    allowedScreens: [],
    allowedModes: [],
    enableCountApi: true,
    isDebug: false,
    isMobile: jQuery('#mobileHeader').length > 0,
    delayBetweenRequests: 200,
    // helper variables
    market: game_data.market,
    units: game_data.units,
    village: game_data.village,
    buildings: game_data.village.buildings,
    sitterId: game_data.player.sitter > 0 ? `&t=${game_data.player.id}` : '',
    coordsRegex: /\d{1,3}\|\d{1,3}/g,

    // internal methods
    _initDebug: function () {
        const scriptInfo = this.scriptInfo();
        console.debug(`${scriptInfo} It works!`);
        if (this.isDebug) {
            console.debug(`${scriptInfo} World:`, game_data.world);
            console.debug(`${scriptInfo} Screen:`, game_data.screen);
        }
    },

    // public methods
    scriptInfo: function (scriptData = this.scriptData) {
        return `[${scriptData.name} ${scriptData.version}]`;
    },
    formatAsNumber: function (number) {
        return parseInt(number).toLocaleString('de');
    },
    tt: function (string) {
        if (this.translations[game_data.locale] !== undefined) {
            return this.translations[game_data.locale][string] ?? string;
        } else {
            return this.translations['en_DK'][string] ?? string;
        }
    },
    getParameterByName: function (name, url = window.location.href) {
        return new URL(url).searchParams.get(name);
    },
    redirectTo: function (location) {
        window.location.assign(game_data.link_base_pure + location);
    },

    // --- fórmula original do jogo/twSDK: custo (em moedas) do enésimo degrau de limite ---
    calculateCoinsNeededForNthNoble: function (noble) {
        return (noble * noble + noble) / 2;
    },

    // dado um total triangular (já guardadas + falta), descobre em que "degrau" (n) estamos
    getNobleTierIndexFromTotal: function (total) {
        return Math.round((-1 + Math.sqrt(1 + 8 * total)) / 2);
    },

    addGlobalStyle: function () {
        return `
            .ra-table-container { overflow-y: auto; overflow-x: hidden; height: auto; max-height: 400px; }
            .ra-table th { font-size: 14px; }
            .ra-table th,
            .ra-table td { padding: 5px; text-align: left; }
            .ra-table tr:nth-of-type(2n) td { background-color: #f0e2be }
            .ra-table tr:nth-of-type(2n+1) td { background-color: #fff5da; }
            .ra-table-v3 { border: 2px solid #bd9c5a; }
            .ra-table-v3 th,
            .ra-table-v3 td { border-collapse: separate; border: 1px solid #bd9c5a; text-align: left; }
            .ra-mb15 { margin-bottom: 15px !important; }
            .ra-highlight td { background-color: #d7f0c7 !important; font-weight: 600; }
        `;
    },
    renderFixedWidget: function (
        body,
        id,
        mainClass,
        customStyle,
        width,
        customName = this.scriptData.name
    ) {
        const globalStyle = this.addGlobalStyle();

        const content = `
            <div class="${mainClass} ra-fixed-widget" id="${id}">
                <div class="${mainClass}-header">
                    <h3>${this.tt(customName)}</h3>
                </div>
                <div class="${mainClass}-body">
                    ${body}
                </div>
                <div class="${mainClass}-footer">
                    <small>
                        <strong>${this.tt(customName)} ${this.scriptData.version}</strong>
                    </small>
                </div>
                <a class="popup_box_close custom-close-button" href="#">&nbsp;</a>
            </div>
            <style>
                .${mainClass} { position: fixed; top: 8vw; right: 8vw; z-index: 99999; border: 2px solid #7d510f; border-radius: 10px; padding: 10px; width: ${
            width ?? '380px'
        }; overflow-y: auto; background: #e3d5b3 url('/graphic/index/main_bg.jpg') scroll right top repeat; }
                .${mainClass} * { box-sizing: border-box; }
                ${globalStyle}
                .custom-close-button { position: absolute; right: 6px; top: 6px; }
                ${customStyle}
            </style>
        `;

        if (jQuery(`#${id}`).length < 1) {
            jQuery('#contentContainer').prepend(content);
            jQuery(`#${id}`).draggable({
                cancel: '.ra-table, input, textarea, button, select, option',
            });
            jQuery(`#${id} .custom-close-button`).on('click', function (e) {
                e.preventDefault();
                jQuery(`#${id}`).remove();
            });
        } else {
            jQuery(`.${mainClass}-body`).html(body);
        }
    },

    // initialize library
    init: async function (scriptConfig) {
        const {
            scriptData,
            translations,
            allowedMarkets,
            allowedScreens,
            allowedModes,
            isDebug,
            enableCountApi,
        } = scriptConfig;

        this.scriptData = scriptData;
        this.translations = translations;
        this.allowedMarkets = allowedMarkets;
        this.allowedScreens = allowedScreens;
        this.allowedModes = allowedModes;
        this.enableCountApi = enableCountApi;
        this.isDebug = isDebug;

        this._initDebug();
    },
};

(async function () {
    await twSDK.init(scriptConfig);
    const scriptInfo = twSDK.scriptInfo();
    const screen = twSDK.getParameterByName('screen');
    const mode = twSDK.getParameterByName('mode');

    try {
        if (screen === 'snob' && !mode) {
            await initNobleScreenMint();
        } else {
            UI.InfoMessage(twSDK.tt('Redirecting...'));
            twSDK.redirectTo('snob');
        }
    } catch (error) {
        UI.ErrorMessage(twSDK.tt('There was an error!'));
        console.error(`${scriptInfo} Error:`, error);
    }

    // ---------------------------------------------------------------
    // Lê o painel "Moedas de ouro" da própria tela (Limite atual de
    // nobres, Já guardadas para o próximo limite, Falta ainda).
    // Não depende de IDs específicos - varre as linhas pela label.
    // ---------------------------------------------------------------
    function getNobleLimitData() {
        const $table = jQuery('.gold-info');
        if (!$table.length) return null;

        let currentLimit = null;
        let saved = null;
        let needed = null;
        let totalCoins = null;

        $table.find('tr').each(function () {
            const $tds = jQuery(this).find('td');
            if ($tds.length < 2) return;

            const label = $tds.eq(0).text().trim();
            const valueText = $tds.eq(1).text().trim();
            const valueNumber = parseInt(valueText.replace(/\D/g, ''), 10);

            if (/^Total/i.test(label)) {
                totalCoins = valueNumber;
            } else if (/Limite atual de nobres/i.test(label)) {
                currentLimit = valueNumber;
            } else if (/J[áa] guardadas/i.test(label)) {
                saved = valueNumber;
            } else if (/Falta ainda/i.test(label)) {
                needed = valueNumber;
            }
        });

        if (currentLimit === null || saved === null || needed === null) {
            return null;
        }

        return { currentLimit, saved, needed, totalCoins };
    }

    // ---------------------------------------------------------------
    // Simula, degrau por degrau (fórmula triangular do jogo), até onde
    // as `newCoins` moedas novas levam o limite de nobres.
    // ---------------------------------------------------------------
    function projectNobleLimit(nobleData, newCoins) {
        let { currentLimit, saved, needed } = nobleData;
        let n = twSDK.getNobleTierIndexFromTotal(saved + needed);
        let pool = newCoins;
        let limit = currentLimit;

        while (pool >= needed) {
            pool -= needed;
            limit++;
            n++;
            needed = twSDK.calculateCoinsNeededForNthNoble(n);
            saved = 0;
        }

        saved += pool;
        needed -= pool;

        return {
            projectedLimit: limit,
            limitsGained: limit - currentLimit,
            savedForNext: saved,
            neededForNext: needed,
        };
    }

    // Initialize script logic when the player is on the Academy screen
    async function initNobleScreenMint() {
        const coinCost = BuildingSnob.Modes.train.storage_item;
        const { wood, stone, iron } = coinCost;

        const { arrivingWood, arrivingClay, arrivingIron, lastArrive } =
            await fetchIncomingTransports();

        const coinWood = Math.floor(arrivingWood / wood);
        const coinClay = Math.floor(arrivingClay / stone);
        const coinIron = Math.floor(arrivingIron / iron);
        const maxCoins = Math.min(coinWood, coinClay, coinIron);

        const nobleData = getNobleLimitData();
        const projection = nobleData
            ? projectNobleLimit(nobleData, maxCoins)
            : null;

        const projectionBlock = projection
            ? `
                <div class="ra-mb15">
                    <table class="ra-table ra-table-v3" width="100%">
                        <thead>
                            <tr><th colspan="2">${twSDK.tt('Noble Limit Projection')}</th></tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td width="65%">${twSDK.tt('Current noble limit')}</td>
                                <td width="35%">${nobleData.currentLimit}</td>
                            </tr>
                            <tr>
                                <td>${twSDK.tt('Coins already saved for next limit')}</td>
                                <td>${twSDK.formatAsNumber(nobleData.saved)}</td>
                            </tr>
                            <tr>
                                <td>${twSDK.tt('Coins still needed for next limit')}</td>
                                <td>${twSDK.formatAsNumber(nobleData.needed)}</td>
                            </tr>
                            <tr>
                                <td>${twSDK.tt('Mintable coins (stock + incoming)')}</td>
                                <td>${twSDK.formatAsNumber(maxCoins)}</td>
                            </tr>
                            <tr class="ra-highlight">
                                <td>${twSDK.tt('Projected noble limit')}</td>
                                <td>${projection.projectedLimit} (+${projection.limitsGained})</td>
                            </tr>
                            <tr>
                                <td>${twSDK.tt('Saved for next limit after this')}</td>
                                <td>${twSDK.formatAsNumber(projection.savedForNext)}</td>
                            </tr>
                            <tr>
                                <td>${twSDK.tt('Still missing for next limit after this')}</td>
                                <td>${twSDK.formatAsNumber(projection.neededForNext)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            `
            : `<p><em>${twSDK.tt('Noble panel not found on this page')}</em></p>`;

        const content = `
            <div class="ra-mb15">
                <table class="ra-table" width="100%">
                    <thead>
                        <tr><th colspan="3">${twSDK.tt('Incoming Resources')}</th></tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><span class="icon header wood"></span> ${twSDK.formatAsNumber(arrivingWood)}</td>
                            <td><span class="icon header stone"></span> ${twSDK.formatAsNumber(arrivingClay)}</td>
                            <td><span class="icon header iron"></span> ${twSDK.formatAsNumber(arrivingIron)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="ra-mb15" style="display:${lastArrive.length ? 'block' : 'none'};">
                <table class="ra-table" width="100%">
                    <thead>
                        <tr><th>${twSDK.tt('Last transport arrives at')}</th></tr>
                    </thead>
                    <tbody>
                        <tr><td>${lastArrive}</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="ra-mb15">
                <table class="ra-table" width="100%">
                    <thead>
                        <tr><th>${twSDK.tt('Max. coins that can be minted')}</th></tr>
                    </thead>
                    <tbody>
                        <tr><td>${twSDK.formatAsNumber(maxCoins)}</td></tr>
                    </tbody>
                </table>
            </div>
            ${projectionBlock}
        `;

        twSDK.renderFixedWidget(content, 'raMintHelperProjecao', 'ra-mint-helper', '');
    }

    // Helper: Fetch incoming transports for the current village
    async function fetchIncomingTransports() {
        const response = await jQuery.get(
            `${game_data.link_base_pure}market&mode=call`
        );
        const htmlDoc = jQuery.parseHTML(response);
        const arrivingWood = parseInt(
            jQuery(htmlDoc).find('#total_wood .wood').text().replace(/.(?=\d{3})/g, '')
        );
        const arrivingClay = parseInt(
            jQuery(htmlDoc).find('#total_stone .stone').text().replace(/.(?=\d{3})/g, '')
        );
        const arrivingIron = parseInt(
            jQuery(htmlDoc).find('#total_iron .iron').text().replace(/.(?=\d{3})/g, '')
        );
        const lastArrive = jQuery(htmlDoc).find('#arrive').text();

        return { arrivingWood, arrivingClay, arrivingIron, lastArrive };
    }
})();
