const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const _ = require("lodash");
const mkdirp = require("mkdirp");
const glob = require("glob");

const [_bin, _script, locale] = process.argv;

const srcDir = path.join(__dirname, "..", "data");
const i18nDir = path.join(srcDir, "translations");
fs.mkdirSync(i18nDir, {recursive: true});

const things = ["cycles", "inks", "rarities", "sets", "traits", "types", "keywords", "cards"];
const dump_options = {
	lineWidth: -1,
	replacer: function(key, value) {
		return _.includes(['text', 'flavor', 'rules'], key) ? `***${value}` : value;
	}
};
const setLanguages = _.reduce(glob.sync("sets/{*,*//*,*//*//*}.yml", {cwd: srcDir}), (map, file) => {
	map[file.replaceAll('sets/', 'printings/')] = yaml.load(fs.readFileSync(path.join(srcDir, file))).languages;
	return map;
}, {});

function loadThings(root) {
	return _.reduce(things, (result, thing) => {
		let files = glob.sync(`${thing}/{*,*//*,*//*//*}.yml`, {
			cwd: root
		});
		files.forEach(file => {
			result[file] = _.pick(yaml.load(fs.readFileSync(path.join(root, file))), ["code", "name", "text", "version", "rules"]);
		});
		return result;
	}, {});
}

function loadPrintings(root) {
	let result = {};
	let files = glob.sync("printings/{*,*//*,*//*//*}.yml", {
		cwd: root
	});
	files.forEach(file => {
		result[file] = _.map(yaml.load(fs.readFileSync(path.join(root, file))), p => _.pick(p, ["code", "flavor"]));
	});
	return result;
}

function mergeData(defaultLocale, locale) {
	return _.reduce(_.union(_.keys(defaultLocale), _.keys(locale)), (result, file) => {
		result[file] = _.merge({}, defaultLocale[file], locale[file]);
		return result;
	}, {});
}

function mergeLists(defaultLocale, locale) {
	return _.reduce(_.union(_.keys(defaultLocale), _.keys(locale)), (result, file) => {
		const codeFn = p => `${p.code}`;
		const sortFn = p => _.find(defaultLocale[file], dp => dp.code == p.code).position;
		result[file] = _(_.merge({}, _.keyBy(defaultLocale[file] || {}, codeFn), _.keyBy(locale[file] || {}, codeFn))).values().sortBy().value();
		return result;
	}, {});
}

const englishThings = loadThings(srcDir);
const englishPrintings = loadPrintings(srcDir);

const codes = locale ? [locale] : _(setLanguages).values().flatten().uniq().value();
codes.forEach(code => {
	if(code === 'en') return;
	console.log(`Updating locale ${code}…`);
	const localeRoot = path.join(i18nDir, code);

	const localeThings = loadThings(localeRoot);
	const localePrintings = loadPrintings(localeRoot);

	const mergedThings = mergeData(englishThings, localeThings);
	const mergedPrintings = mergeLists(englishPrintings, localePrintings);
	
	_.each(_.keys(mergedThings), file => {
		if(_.has(setLanguages, file) && !_.includes(setLanguages[file], code)) return;
		const target = path.join(localeRoot, file);
		mkdirp.sync(path.dirname(target));
		if(!_.isEqual(localeThings[file], mergedThings[file])) {
			fs.writeFileSync(target, yaml.dump(mergedThings[file], dump_options));
			console.log(`Written ${target}`);
		}
	});

	_.each(_.keys(mergedPrintings), file => {
		if(_.has(setLanguages, file) && !_.includes(setLanguages[file], code)) return;
		const target = path.join(localeRoot, file);
		mkdirp.sync(path.dirname(target));
		if(!_.isEqual(localePrintings[file], mergedPrintings[file])) {
			fs.writeFileSync(target, yaml.dump(mergedPrintings[file], dump_options));
			console.log(`Written ${target}`);
		}
	});
});