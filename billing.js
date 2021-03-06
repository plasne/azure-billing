
// includes
const cmd = require("commander");
const request = require("request");
const child_process = require("child_process");
const Spinner = require("cli-spinner").Spinner;
const fs = require("fs");
const numbro = require("numbro");
const moment = require("moment");

// define options
cmd
    .version("1.0.0")
    .option("-o, --offer <value>", `Specify the Offer ID for the rate card; should start with "MS-AZR-".`)
    .option("-f, --from <date>", `Specify the start date in the following format: "YYYY-MM-DD". This is inclusive.`)
    .option("-t, --to <date>", `Specify the end date in the following format: "YYYY-MM-DD". This is inclusive.`)
    .option("-c, --count <n>", `Show the top n most expensive entries per day.`, parseInt)
    .parse(process.argv);

// set global variables
const count = cmd.count || 5;
const offer = (value => {
    if (typeof value === "string" && value.substring(0, 7) === "MS-AZR-") {
        return value;
    } else {
        console.error(`You must specify a valid offer beginning with "MS-AZR-".`);
        process.exit(1);
    }
})(cmd.offer);
const from = (value => {
    if (typeof value === "string" && /\d{4}-\d{2}-\d{2}$/g.test(value) && moment(value).isValid()) {
        return moment.utc(value);
    } else {
        console.error(`You must specify a valid from date in the following format: "YYYY-MM-DD".`);
        process.exit(1);
    }
})(cmd.from);
const to = (value => {
    if (typeof value === "string" && /\d{4}-\d{2}-\d{2}$/g.test(value) && moment(value).isValid()) {
        return moment.utc(value);
    } else {
        console.error(`You must specify a valid to date in the following format: "YYYY-MM-DD".`);
        process.exit(1);
    }
})(cmd.to);

// configure spinner
Spinner.setDefaultSpinnerDelay(250);
Spinner.setDefaultSpinnerString("|/-\\");

// run a command
function run(command, message) {
    return new Promise((resolve, reject) => {
        const spinner = new Spinner(`${message}... %s`);
        spinner.start();
        child_process.exec(command, (err, stdout, stderr) => {
            spinner.stop(true);
            if (!err) {
                resolve(stdout);
            } else {
                reject(err, stderr);
            }
        });
    });
}

// query a service
function query(url, accessToken, message) {
    return new Promise((resolve, reject) => {
        const spinner = new Spinner(`${message}... %s`);
        spinner.start();
        request.get({
            uri: url,
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        }, function(error, response, body) {
            spinner.stop(true);
            if (!error && response.statusCode == 200) {
                resolve(body);
            } else if (error) {
                reject(error);
            } else {
                reject(new Error(`HTTP ${response.statusCode}: ${body}`));
            }
        });
    });
}

// load a file
function load(path) {
    return new Promise((resolve, reject) => {
        fs.readFile(path, "utf-8", (err, data) => {
            if (!err) {
                resolve(data);
            } else {
                reject(err);
            }
        });
    });
}

// main
(async _ => {
    try {

        // get an access token
        const tokenResponse = await (async _ => {
            try {
                const raw = await run("az account get-access-token", "Authenticating");
                const response = JSON.parse(raw);
                return response;
            } catch(ex) {
                console.error(ex);
                console.log("\nMake sure you have install the Azure CLI 2.0 tool and have logged in!\n");
                process.exit(1);
            }
        })();
        const accessToken = tokenResponse.accessToken;
        const subscription = tokenResponse.subscription;

        // get the rate card
        const rateCard = await (async _ => {
            return await load(`./${offer}.rates`)
            .then(data => {
                return JSON.parse(data);
            })
            .catch(async ex => {
                try {
                    const currency = "USD", locale = "en-US", region = "US";
                    const rates = await query(
                        `https://management.azure.com/subscriptions/${subscription}/providers/Microsoft.Commerce/RateCard?api-version=2015-06-01-preview&$filter=OfferDurableId eq '${offer}' and Currency eq '${currency}' and Locale eq '${locale}' and RegionInfo eq '${region}'`,
                        accessToken,
                        "Fetching rate card (can take a few minutes)"
                    );
                    await fs.writeFile(`./${offer}.rates`, rates, "utf-8", err => {
                        if (err) console.error(err);
                    });
                    return JSON.parse(rates);
                } catch(ex) {
                    console.error(ex);
                    process.exit(1);
                }
            });
        })();
        console.log(`${numbro(rateCard.Meters.length).format({ thousandSeparated: true })} rates loaded.`);

        // get the usage
        const usage = await (async _ => {
            try {
                const all = [];
                const reportedStartTime = from.clone().utc().add(-1, "day").format("YYYY-MM-DDTmm:HH:ssZ").replace(/:/g, "%3a").replace(/\+/g, "%2b");
                let endTime = to.clone().utc().add(2, "day");
                const latest = moment().utc();
                if (endTime > latest) endTime = latest.startOf("day");
                const reportedEndTime = endTime.format("YYYY-MM-DDTmm:HH:ssZ").replace(/:/g, "%3a").replace(/\+/g, "%2b")
                let url = `https://management.azure.com/subscriptions/${subscription}/providers/Microsoft.Commerce/UsageAggregates?api-version=2015-06-01-preview&reportedStartTime=${reportedStartTime}&reportedEndTime=${reportedEndTime}&aggregationGranularity=Daily&showDetails=false`;
                do {
                    const raw = await query(url, accessToken, "Fetching usage");
                    const uses = JSON.parse(raw);
                    for (const row of uses.value) {
                        all.push(row);
                    }
                    url = (uses.nextLink) ? uses.nextLink : "";
                } while (url.length > 0);
                return all;
            } catch(ex) {
                console.error(ex);
                process.exit(1);
            }
        })();

        // add rate and cost
        if (usage) {
            for (const row of usage) {
                const rate = rateCard.Meters.find(meter => meter.MeterId === row.properties.meterId);
                if (rate) {
                    if (rate.Unit === row.properties.unit) {
                        row.rate = rate.MeterRates["0"];
                        row.cost = row.properties.quantity * row.rate;
                    } else {
                        console.error(`Unit mismatch for ${row.properties.meterCategory} - ${row.properties.meterSubCategory}, rateCard is in ${meter.MeterId} vs. usage in ${row.properties.meterId}.`);
                    }
                } else if (row.name.startsWith("Daily_BRSDT_")) {
                    // ignore aggregates
                } else {
                    console.error(`No rate found for ${row.properties.meterCategory} - ${row.properties.meterSubCategory}.`);
                }
            }
        } else {
            console.log("No usage data found for the date range...");
        }

        // group by date
        const byDate = [];
        for (const row of usage) {
            if (row.rate) {
                const grouping = row.properties.usageStartTime.substring(0, 10);
                let group = byDate.find(g => g.name === grouping);
                if (!group) {
                    group = {
                        name: grouping,
                        entries: []
                    };
                    byDate.push(group);
                }
                let name = (row.properties.meterSubCategory) ? `${row.properties.meterCategory} - ${row.properties.meterSubCategory}` : `${row.properties.meterCategory}`;
                if (row.properties.meterCategory === "Storage") name += ` - ${row.properties.meterName}`;
                const entry = group.entries.find(e => e.name === name && e.rate === row.rate && e.unit === row.properties.unit);
                if (entry) {
                    entry.quantity += row.properties.quantity;
                } else {
                    group.entries.push({
                        name: name,
                        quantity: row.properties.quantity,
                        rate: row.rate,
                        unit: row.properties.unit
                    });
                }
            }
        }

        // summarize
        let global_total = 0, global_represents = 0;
        byDate.sort((a, b) => a.name.localeCompare(b.name));
        for (const group of byDate) {
            const groupDate = moment.utc(group.name);
            if (groupDate >= from && groupDate <= to) {
                let local_total = 0, local_represents = 0, index = 0, output = [];
                group.entries.sort((a, b) => b.cost - a.cost);
                for (const entry of group.entries) {
                    const cost = entry.quantity * entry.rate;
                    global_total += cost;
                    local_total += cost;
                    if (index < count) {
                        output.push(`  ${entry.name}, ${entry.quantity} ${entry.unit} @ $${entry.rate} = ${numbro(cost).formatCurrency({ mantissa: 2 })}`);
                        global_represents += cost;
                        local_represents += cost;
                    }
                    index++;
                }
                console.log(`date: ${group.name}; represents ${numbro(local_represents).formatCurrency({ mantissa: 2 })} of the ${numbro(local_total).formatCurrency({ mantissa: 2 })} total.`);
                for (const line of output) {
                    console.log(line);
                }
            }
        }
        console.log(`represents ${numbro(global_represents).formatCurrency({ mantissa: 2 })} of the ${numbro(global_total).formatCurrency({ mantissa: 2 })} total.`);

    } catch(ex) {
        console.error(ex);
        process.exit(1);
    }
})();
