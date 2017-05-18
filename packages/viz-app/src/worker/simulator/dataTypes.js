'use strict';

const _ = require('underscore');

// TODO customize based on user/content preferences:
const DefaultLocale = 'en-US';
// TODO customize based on user/content preferences, and/or per column.
const LocaleCompareOptions = {usage: 'sort', numeric: true};
// Construct a single Collator for compare calls (to avoid )
const defaultLocaleCollator = new Intl.Collator(DefaultLocale, LocaleCompareOptions);

const SupportedDataTypes = [
    'number',
    'integer',
    'string',
    'array',
    'date',
    'datetime',
    /*'money',*/
    'object'
];

// Taken from http://stackoverflow.com/questions/14313183/javascript-regex-how-do-i-check-if-the-string-is-ascii-only
function isASCII(str, extended) {
    return (extended ? /^[\x00-\xFF]*$/ : /^[\x00-\x7F]*$/).test(str);
}

function fastRoughStringCompare (a, b) {
    return (a<b ? -1 : (a>b ? 1 : 0));
}

function wrappedLocaleCompare (a, b) {
    if (isASCII(a) && isASCII(b)) {
        return fastRoughStringCompare(a, b);
    }
    return defaultLocaleCollator.compare(a, b);
}

export function numberSignifiesUndefined(value) {
    return isNaN(value);
}

export function int32SignifiesUndefined(value) {
    return value === 0x7FFFFFFF;
}

export function dateSignifiesUndefined(value) {
    const dateObj = new Date(value);
    return isNaN(dateObj.getTime());
}

export function stringSignifiesUndefined(value) {
    // TODO retire 'n/a'
    return value === '\0' || value === 'n/a';
}

export function valueSignifiesUndefined(value) {
    switch (typeof value) {
        case 'undefined':
            return true;
        case 'string':
            return stringSignifiesUndefined(value);
        case 'number':
            return numberSignifiesUndefined(value) || int32SignifiesUndefined(value);
        case 'date':
        case 'datetime':
            return dateSignifiesUndefined(value);
        case 'object':
        case 'array':
            return false;
        default:
            return false;
    }
}

export function keyMakerForDataType(dataType) {
    switch (dataType) {
        case 'undefined':
        case 'number':
        case 'integer':
            return (value) => value.toString();
        case 'string':
            return (value) => value;
        case 'date':
            return (value) => value.toDateString();
        case 'datetime':
            return (value) => value.toISOString();
        case 'object':
            return (value) => value === null ? value.toString() : JSON.stringify(value);
        case 'array':
            return (value) => JSON.stringify(value);
        default:
            return (value) => value.toString();
    }
}

export function isCompatible(dataType, value) {
    switch (dataType) {
        case 'undefined':
            return value === undefined;
        case 'number':
            return _.isNumber(value);
        case 'integer':
            return _.isNumber(value) && parseInt(value) === value;
        case 'string':
            return _.isString(value);
        case 'date':
        case 'datetime':
            return _.isDate(value);
        case 'object':
            return _.isObject(value);
        case 'array':
            return _.isArray(value);
        default:
            return true;
    }
}

export function isLessThanForDataType(dataType) {
    switch (dataType) {
        case 'string':
            return (a, b) => wrappedLocaleCompare(a,b) === -1;
        default:
            return (a, b) => a < b;
    }
}

export function comparatorForDataType(dataType) {
    switch (dataType) {
        case 'number':
        case 'integer':
            return (a, b) => a - b;
        case 'string':
            return (a, b) => wrappedLocaleCompare(a,b);
        case 'date':
        case 'datetime':
            return (a, b) => a.getTime() - b.getTime();
        default:
            return undefined;
    }
}

export function roundUpBy(num, multiple = 0) {
    if (multiple === 0) {
        return num;
    }

    const div = num / multiple;
    return multiple * Math.ceil(div);
}

export function roundDownBy(num, multiple = 0) {
    if (multiple === 0) {
        return num;
    }

    const div = num / multiple;
    return multiple * Math.floor(div);
}

export function dateIncrementors(timeAggLevel) {
    // TODO: Rest of time ranges
    switch (timeAggLevel) {
        case 'day':
            return {
                inc: (date) => date.setHours(24,0,0,0),
                dec: (date) => date.setHours(0,0,0,0)
            };
        case 'hour':
            return {
                inc: (date) => date.setMinutes(60,0,0),
                dec: (date) => date.setMinutes(0,0,0)
            };
        case 'minute':
            return {
                inc: (date) => date.setSeconds(60,0),
                dec: (date) => date.setSeconds(0,0)
            };
        case 'second':
            return {
                inc: (date) => date.setMilliseconds(1000),
                dec: (date) => date.setMilliseconds(0)
            };
    }
    return undefined;
}