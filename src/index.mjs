import * as fs from 'fs';
import {Readable} from 'stream';
import {finished} from 'stream/promises';
import {request, gql, GraphQLClient} from 'graphql-request'

/**
 * Configuration
 */
const DEBUG = false;
const specialCases = {
    "627e14b21713922ded6f2c15": 250000,
    "634959225289190e5e773b3b": 15000
};

const query = gql`
{
    items(lang: en) {
        id
        name
        avg24hPrice
        changeLast48hPercent
        historicalPrices {
            price
            timestamp
        }
    }
}
`

const main = (async () => {
    // Fetch data
    if (!DEBUG) {
        const endpoint = 'https://api.tarkov.dev/graphql'
        const client = new GraphQLClient(endpoint, { errorPolicy: 'ignore' })
        const tarkovDevPrices =await client.request(query)
        fs.writeFileSync('tarkovdevprices.json', JSON.stringify(tarkovDevPrices, null, 4));

        // Fetch the latest prices.json and handbook.json from SPT-AKI's git repo
        let akiOnline, akiBranch;
        process.argv.forEach((arg) => {
            if (arg.startsWith('--aki-online') && arg.indexOf('=') !== -1) {
                akiOnline = arg.split('=')[1].toLowerCase() === 'true';
            } else if (arg.startsWith('--aki-branch') && arg.indexOf('=') !== -1) {
                akiBranch = arg.split('=')[1];
            }
        });

        if (akiOnline || !fs.existsSync('akihandbook.json')) {
            console.log('File akihandbook.json not exists, downloading online...');
            await downloadFile('https://dev.sp-tarkov.com/SPT/Server/raw/branch/' + akiBranch + '/project/assets/database/templates/handbook.json', 'akihandbook.json');
            console.log('Downloading akihandbook.json success.');
        } else {
            console.log('File akihandbook.json exists.If you want to update it online, please run: node src/index.mjs --aki-online=true --aki-branch=master');
        }
        if (akiOnline || !fs.existsSync('akiitems.json')) {
            console.log('File akiitems.json not exists, Downloading online...');
            await downloadFile('https://dev.sp-tarkov.com/SPT/Server/raw/branch/' + akiBranch + '/project/assets/database/templates/items.json', 'akiitems.json');
            console.log('Downloading akiitems.json success.');
        } else {
            console.log('File akiitems.json exists.If you want to update it online, please run: node src/index.mjs --aki-online=true --aki-branch=master');
        }
        if (akiOnline || !fs.existsSync('akiprices.json')) {
            console.log('File akiprices.json not exists, Downloading online...');
            await downloadFile('https://dev.sp-tarkov.com/SPT/Server/raw/branch/' + akiBranch + '/project/assets/database/templates/prices.json', 'akiprices.json');
            console.log('Downloading akiprices.json success.');
        } else {
            console.log('File akiprices.json exists.If you want to update it online, please run: node src/index.mjs --aki-online=true --aki-branch=master');
        }
    }

    processData();
});

const processData = (() => {
    console.info('start fetching flea prices');
    // Read in data
    const tarkovDevPrices = JSON.parse(fs.readFileSync('tarkovdevprices.json', 'utf-8'));
    const akiHandbook = JSON.parse(fs.readFileSync('akihandbook.json', 'utf-8'));
    const akiItems = JSON.parse(fs.readFileSync('akiitems.json', 'utf-8'));
    const akiPrices = JSON.parse(fs.readFileSync('akiprices.json', 'utf-8'));

    // Start with a base of the SPT price list
    const priceList = structuredClone(akiPrices);

    // Filter tarkov.dev prices in the same way SPT does
    const filteredTarkovDevPrices = processTarkovDevPrices(tarkovDevPrices);

    // Get a price for each item in the items list
    for (const itemId in filteredTarkovDevPrices) {
        const itemPrice = filteredTarkovDevPrices[itemId];
        if (itemPrice.Average7DaysPrice !== 0) {
            priceList[itemId] = itemPrice.Average7DaysPrice;
        }
    }

    // Ammo packs are easy to exploit, they're never listed on flea which causes server to use handbook price, often contain ammo worth x100 the cost of handbook price
    const ammoPacks = Object.values(akiItems)
        .filter(x => (x._parent === "5661632d4bdc2d903d8b456b" || x._parent === "543be5cb4bdc2deb348b4568")
            && (x._name.includes("item_ammo_box_") || x._name.includes("ammo_box_"))
            && !x._name.includes("_damaged"));

    for (const ammoPack of ammoPacks) {
        if (!priceList[ammoPack._id]) {
            if (DEBUG) console.info(`edge case ammo pack ${ammoPack._id} ${ammoPack._name} not found in prices, adding manually`);
            // get price of item to multiply price of
            const itemMultipler = ammoPack._props.StackSlots[0]._max_count;
            const singleItemPrice = getItemPrice(priceList, akiHandbook.Items, ammoPack._props.StackSlots[0]._props.filters[0].Filter[0]);
            const price = singleItemPrice * itemMultipler;

            priceList[ammoPack._id] = price;

        }
    }

    // Some items dont get listed on flea often, manually add prices for these
    for (const specialCaseId of Object.keys(specialCases)) {
        const specialCasePrice = specialCases[specialCaseId];
        if (!priceList[specialCaseId]) {
            if (DEBUG) console.info(`edge case item ${specialCaseId} not found in prices, adding manually`);
            priceList[specialCaseId] = specialCasePrice;
        }
    }

    // Write out the updated price data
    fs.writeFileSync('prices.json', JSON.stringify(priceList, null, 4));
    console.info('end fetching flea prices');
});

const processTarkovDevPrices = ((tarkovDevPrices) => {
    const filteredTarkovDevPrices = {};

    for (const item of tarkovDevPrices.items) {
        // For some reason, tarkov.dev is sending back invalid items, exclude them
        if (!item.id.match(/^[a-fA-F0-9]+$/)) {
            if (DEBUG) console.warn(`Skipping invalid item ${item.id}`);
            continue;
        }

        if (item.historicalPrices.length === 0) {
            if (DEBUG) console.error(`unable to add item ${item.id} ${item.name} with no historical prices, ignoring`);
            continue;
        }

        if (item.changeLast48hPercent > 100) {
            console.warn(`Item ${item.id} ${item.name} Has had recent ${item.changeLast48hPercent}% increase in price. ${item.historicalPrices.length} price values`);
        }

        const averagedItemPrice = getAveragedPrice(item);
        if (averagedItemPrice === 0) {
            if (DEBUG) console.error(`unable to add item ${item.id} ${item.name} with average price of 0, ignoring`);
            continue;
        }

        if (item.name.indexOf(" (0/") >= 0) {
            if (DEBUG) console.warn(`Skipping 0 durability item: ${item.id} ${item.name}`);
            continue;
        }

        filteredTarkovDevPrices[item.id] = {
            Name: item.name,
            Average24hPrice: item.avg24hPrice,
            Average7DaysPrice: averagedItemPrice,
            TemplateId: item.id
        };

        if (DEBUG) console.log(`Adding item: ${item.id} ${item.name}`);
    }

    return filteredTarkovDevPrices;
});

const getAveragedPrice = ((item) => {
    const fourteenDaysAgoTimestamp = new Date(Date.now() - 12096e5);
    let filteredPrices = item.historicalPrices.filter(x => x.timestamp > fourteenDaysAgoTimestamp).sort((a, b) => a.price - b.price);

    if (filteredPrices.length === 0) {
        filteredPrices = item.historicalPrices;
    }

    if (filteredPrices.length === 1) {
        return 0;
    }

    const prices = filteredPrices.map(x => x.price);
    const avgMean = getAverage(prices);
    const standardDev = getStandardDeviation(prices);
    const upperCutoff = standardDev * 1.5;
    const lowerCutoff = standardDev * 2;
    const lowerBound = avgMean - lowerCutoff;
    const upperBound = avgMean + upperCutoff;
    const pricesWithOutliersRemoved = prices.filter(x => x >= lowerBound && x <= upperBound);
    const avgPriceWithoutOutliers = Math.round(getAverage(pricesWithOutliersRemoved));
    return avgPriceWithoutOutliers;
});

const getItemPrice = ((priceList, handbookItems, itemTpl) => {
    const fleaPrice = priceList[itemTpl];
    if (!fleaPrice) {
        return handbookItems.find(x => x.Id === itemTpl).Price;
    }
    return fleaPrice;
});

const downloadFile = (async (url, filename) => {
    const res = await fetch(url);
    const fileStream = fs.createWriteStream(filename, {flags: 'w'});
    await finished(Readable.fromWeb(res.body).pipe(fileStream));
});

const getStandardDeviation = ((array) => {
    const n = array.length;
    const mean = getAverage(array);
    return Math.sqrt(array.map(x => (x - mean) ** 2).reduce((a, b) => a + b) / n);
});

const getAverage = ((array) => {
    return array.reduce((a, b) => a + b, 0) / array.length;
});

// Trigger main
await main();
