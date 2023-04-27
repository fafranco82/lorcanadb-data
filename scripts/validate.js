const _ = require("lodash");
const { plural } = require("pluralize");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Ajv = require("ajv");

const ajv = new Ajv({allErrors: true});

const keysort = [
	"code", "card", "name", "version", "cost", "ink", "inkwell",
	"traits", "strength", "willpower", "lore", "text", "keywords", "set",
	"position", "rarity", "illustrator", "flavor", "args",
	"rules", "cycle", "size", "languages"
];

const dump_options = {
	schema: {
		lineWidth: -1,
		sortKeys: (a, b) => {
			if(_.includes(keysort, a) && _.includes(keysort, b))
				return _.indexOf(keysort, a) - _.indexOf(keysort, b);
			else
				return 0;

		}
	},
	data: {
		lineWidth: -1,
		replacer: function(key, value) {
			return _.includes(['text', 'flavor', 'rules'], key) ? `***${value}` : value;
		},
		sortKeys: (a, b) => {
			if(_.includes(keysort, a) && _.includes(keysort, b))
				return _.indexOf(keysort, a) - _.indexOf(keysort, b);
			else
				return 0;

		}
	}
};

class ValidationError extends Error {
	constructor (message) {
		super(message);
		this.name = this.constructor.name;
		Error.captureStackTrace(this, this.constructor);
	}
}

function checkDirAccess(path) {
	if(!fs.existsSync(path)) {
		throw new ValidationError(`${path} is not a valid path`);
	}

	const stat = fs.statSync(path);
	if(!stat.isDirectory()) {
		throw new ValidationError(`${path} is not a valid path`);
	}

	try {
		fs.accessSync(path, fs.constants.R_OK);
	} catch(err) {
		throw new ValidationError(`${path} is not a readable directory`);	
	}
}

function testFileAccess(path) {
	if(!fs.existsSync(path)) {
		return `${path} does not exists`;
	}

	const stat = fs.statSync(path);
	if(!stat.isFile()) {
		return `${path} does not exists`;
	}

	try {
		fs.accessSync(path, fs.constants.R_OK);
	} catch(err) {
		return `${path} is not a readable file`;	
	}

	return;
}

function checkFileAccess(path) {
	let result = testFileAccess(path);
	if(!!result) {
		throw new ValidationError(result);
	}
}

function c(message) {
	return `\x1b[32m${message}\x1b[0m`;
}

class Logger {
	constructor(verbose, indent, prefix) {
		this.verbose = verbose;
		this.indent = indent || 0;
		this.prefix = prefix || "";
		this.togglePrefix = true;
	}

	log(text, minimumVerbosity=0) {
		if(this.verbose >= minimumVerbosity) {
			if(this.togglePrefix) {
				process.stdout.write(_.repeat(" ", this.indent));
				process.stdout.write(this.prefix);
			}
			this.togglePrefix = false;
			process.stdout.write(text);
			if(_.includes(text, "\n")) this.togglePrefix = true;
		}
	}
}

class ValidatorBase {
	constructor(basePath, logger, fixFormatting) {
		this.basePath = basePath;
		this.dataPath = path.join(basePath, "data");
		this.schemaPath = path.join(basePath, "schema");
		this.logger = logger;
		this.fixFormatting = fixFormatting;
		this.collections = {};

		this.errors = {
			formatting: 0,
			validation: 0,
			nonFixedFormatting: 0
		};
	}

	log(message, verbosity) {
		this.logger.log(message, verbosity);
	}

	showResults() {
		this.log(`Found ${c(this.errors.formatting)} formatting and ${c(this.errors.validation)} validation errors\n`, 0);
		process.exitCode = (this.errors.formatting+this.errors.validation) == 0 ? 0 : 1;
	}

	validate() {
		checkDirAccess(this.dataPath);
		checkDirAccess(this.schemaPath)
		this.log("Validating data...\n", 0);

		const things = {
			"ink": {},
			"trait": {},
			"keyword": {},
			"cycle": {},
			"rarity": {},
			"set": {},
			"type": {},
			"card": {
				pathInfo: (path) => ({
					type: path.split("/")[0]
				})
			},
			"printing": {}
		};
		for(const [thing, info] of Object.entries(things)) {
			const collection = this.loadCollection(thing, info);
			if(!!collection) this.loadCollections(thing, collection);
		}
	}

	loadCollections(thing, collection) {
		if(!this.collections[thing])
			this.collections[thing] = {};

		for(const item of collection) {
			this.collections[thing][item.code] = item;
		}
	}

	loadCollection(thing, info) {
		const pluralThing = plural(thing);
		this.log(`Loading collection of ${c(pluralThing)}...\n`, 1);

		const thingPath = path.join(this.dataPath, `${pluralThing}`);
		checkDirAccess(thingPath);

		let thingsData = this.loadThingsData(thingPath, info);
		if(!this.validateCollection(thing, thingsData)) return;

		return thingsData;
	}

	loadThingsData(thingPath, info) {
		let files = glob.sync("**/*.yml", {
			cwd: thingPath
		});

		let collection = [];
		for(const file of files) {
			let list = this.getDataFromFile(path.join(thingPath, file));
			if(!_.isArray(list)) list = [list];
			for(let item of list) {
				if(info.pathInfo) {
					item = _.extend({}, item, info.pathInfo(file));
				}
				collection.push(item);
			}
		}

		return collection;
	}

	validateCollection(thing, thingsData) {
		const pluralThing = plural(thing);
		this.log(`Validating collection of ${c(pluralThing)}\n`, 1);

		const schemaPath = path.join(this.schemaPath, `${thing}_schema.yml`);
		checkFileAccess(schemaPath);
		const schemaData = this.getDataFromFile(schemaPath);


		if(!schemaData) return false;
		const validator = this.checkJsonSchema(schemaData, schemaPath);
		if(!validator) return false;

		let retVal = true;
		for(const thingData of thingsData) {
			retVal = this.validateSchema(thing, thingData, validator) && retVal;
		}

		return retVal;
	}

	validateSchema(thing, thingData, validator) {
		this.log(`Validating ${c(thing)} ${thingData.code}... `, 2);
		const valid = validator(thingData);
		if(valid) {
			const customErrors = this.customCheck(thing, thingData);
			if(customErrors.length == 0) {
				this.log(" OK\n", 2);
			} else {
				this.log(" ERROR\n", 2);
				this.log(`Validation error in ${c(thing)}: (code: ${thingData.code})\n`, 0);
				this.errors.validation++;
				this.log(_(customErrors).map(e => `  - ${e}`).join("\n")+"\n", 0);
			}
		} else {
			this.log(" ERROR\n", 2);
			this.log(`Validation error in ${c(thing)}: (code: ${thingData.code})\n`, 0);
			this.errors.validation++;
			this.log(_(validator.errors).map(e => `  - ${c(thing+e.instancePath.replaceAll("/", "."))} ${e.message}`).join("\n")+"\n", 0);
		}
		return valid;
	}

	customCheck(thing, thingData) {
		const methodName = `customCheck${_.upperFirst(thing)}`;
		if(!!this[methodName]  && typeof this[methodName] === 'function') {
			return this[methodName](thingData);
		} else {
			return [];
		}
	}

	customCheckKeyword(data) {
		let validations = [];
		const re = /\{(.+?)\}/ig;

		if(re.test(data.rules)) {
			for(const [__, expr] of data.rules.match(re)) {
				if(!_.includes(data.args || [], expr)) {
					validations.push(`Expression {${c(expr)}} is not defined as arg in keyword ${c(data.code)}`);
				}
			}
		}		

		return validations;
	}

	customCheckSet(data) {
		let validations = [];

		if(!!data.cycle && !this.collections['cycle'][data.cycle])
			validations.push(`Cycle code '${data.cycle}' does not exists in set '${c(data.code)}'`);

		return validations;
	}

	customCheckCard(data) {
		let validations = [];

		if(!!data.type && !this.collections['type'][data.type])
			validations.push(`Type code '${data.type}' does not exists in set '${c(data.code)}'`);

		if(!!data.ink && !this.collections['ink'][data.ink])
			validations.push(`Ink code '${data.ink}' does not exists in set '${c(data.code)}'`);

		for (const keyword of (data.keywords || [])) {
			if(!this.collections['keyword'][keyword])
				validations.push(`Keyword code '${keyword}' does not exists in set '${c(data.code)}'`);
		}

		for (const trait of (data.traits || [])) {
			if(!this.collections['trait'][trait])
				validations.push(`Trait code '${trait}' does not exists in set '${c(data.code)}'`);
		}

		const methodName = `customCheckCard${_.upperFirst(data.type)}`;
		if(!!this[methodName]  && typeof this[methodName] === 'function') {
			validations = validations.concat(this[methodName](data));
		}

		return validations;
	}

	customCheckCardCharacter(data) {
		let validations = [];

		const requiredFields = ["version", "strength", "willpower", "lore"];
		for(const required of requiredFields) {
			if(!_.has(data, required)) {
				validations.push(`Character card code ${c(data.code)} must have attribute ${required}`);
			}
		}

		return validations;
	}

	getDataFromFile(filepath) {
		try {
			let data = fs.readFileSync(filepath, "utf8");
			let json = yaml.load(data);

			this.log(`${path.relative(this.basePath, filepath)}: Checking YAML formatting...\n`, 4);
			let formattedData = this.formatYaml(json, _.includes(filepath, 'schema') ? dump_options.schema : dump_options.data);
			if(formattedData !== data) {
				this.log(`${path.relative(this.basePath, filepath)}: File is not correctly formatted YAML\n`, 0);
				this.errors.formatting++;
				if(this.fixFormatting && formattedData && formattedData.length > 0) {
					this.log(`${path.relative(this.basePath, filepath)}: Fixing YAML formatting...\n`, 0);
					try {
						fs.writeFileSync(filepath, formattedData);
					}
					catch(e) {
						this.errors.nonFixedFormatting++;
						this.log(`${path.relative(this.basePath, filepath)}: Cannot open file to write.\n`, 0)
					}
				} else {
					this.errors.nonFixedFormatting++;
				}
			}
			return json;
		}
		catch(e) {
			this.log(`${filepath}: File is not correctly formatted YAML\n`, 0);
			this.errors.validation++;
			console.error(e);
			return [];
		}
	}

	formatYaml(data, options) {
		let yamlText = _.reduce(yaml.dump(data, options).split("\n"), (lines, line) => {
			if(line.startsWith("-") && lines.length > 0) return lines.concat(["", line]);
			else return lines.concat(line);
		}, []);
		return yamlText.join("\n");
	}

	checkJsonSchema(data, schemaPath) {
		try {
			return ajv.compile(data);
		} catch(err) {
			this.log(`${schemaPath}: schema file is not a valid JSON Schema\n`, 0);
			console.error(err);
			this.errors.validation++;
			return;
		}
	}
}

class Validator extends ValidatorBase {
	constructor(basePath, logger, fixFormatting) {
		super(basePath, logger, fixFormatting);
	}

	validate() {
		super.validate();

		if(this.errors.validation == 0) {
			this.validateLocales()
		} else {
			this.log("There were errors in main files. Validation of translated files skipped.\n", 0);
		}
	}

	validateLocales() {
		const locales = _(this.collections.set).values().map(s => s.languages).flatten().uniq().filter(lang => lang !== "en").value();
		for(const locale of locales) {
			const i18nLogger = new Logger(this.logger.verbose, this.logger.indent+4, `[${locale}] `);
			const i18nValidator = new I18NValidator(this.collections, locale, this.basePath, i18nLogger, this.fixFormatting);
			i18nValidator.validate();
			this.errors.validation += i18nValidator.errors.validation;
			this.errors.formatting += i18nValidator.errors.formatting;
			this.errors.nonFixedFormatting += i18nValidator.errors.nonFixedFormatting;
		}
	}
}

class I18NValidator extends ValidatorBase {
	constructor(collections, locale, basePath, logger, formatting) {
		super(basePath, logger, formatting);
		this.collections = collections;
		this.locale = locale;
		this.dataPath = path.join(this.dataPath, 'translations', this.locale);
		this.schemaPath = path.join(this.schemaPath, 'translations');
	}

	customCheck(thing, thingData) {
		let validations = [];

		if(!!thingData.code && !this.collections[thing][thingData.code])
			validations.push(`${c(thing)} code '${thingData.code}' does not exists in '${this.locale}' ${thing} translations`);

		return validations;
	}

	
	customCheckKeyword() {
		return [];
	}

	customCheckCardCharacter() {
		return [];
	}
}

function main() {
	const basePath = path.resolve(__dirname, "..");
	const validator = new Validator(basePath, new Logger(0), true);
	validator.validate();
	validator.showResults();
}

main();