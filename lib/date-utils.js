/**
 * Business Date Utilities for Speed Money Platform
 * 
 * Standard Business Timezone: India Standard Time (IST, UTC+05:30)
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Validates a YYYY-MM-DD date string for format and calendar validity.
 * @param {string} str
 * @returns {boolean}
 */
function isValidDateString(str) {
    if (!str || typeof str !== "string") return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;

    const [year, month, day] = str.split("-").map(Number);
    if (year < 2000 || year > 2100) return false;
    if (month < 1 || month > 12) return false;

    // Check days in month
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) return false;

    return true;
}

/**
 * Returns today's date formatted as YYYY-MM-DD in IST.
 * @returns {string}
 */
function getTodayIST() {
    const now = new Date();
    const istDate = new Date(now.getTime() + IST_OFFSET_MS);
    return istDate.toISOString().slice(0, 10);
}

/**
 * Converts a YYYY-MM-DD date string (or defaults to today in IST)
 * into inclusive start and exclusive end timestamps in UTC.
 * 
 * @param {string} [dateStr] Optional date in YYYY-MM-DD format
 * @returns {{ businessDate: string, startOfDay: Date, endOfDay: Date, endOfDayInclusive: Date }}
 */
function getBusinessDayRange(dateStr) {
    const businessDate = dateStr ? dateStr.trim() : getTodayIST();

    if (!isValidDateString(businessDate)) {
        throw new Error(
            `Invalid date format: '${businessDate}'. Expected YYYY-MM-DD with valid calendar values.`
        );
    }

    // Start of day in IST (00:00:00.000+05:30)
    const startOfDay = new Date(`${businessDate}T00:00:00+05:30`);
    // Exclusive end of day in IST (00:00:00.000+05:30 of next day)
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    // Inclusive end of day in IST (23:59:59.999+05:30)
    const endOfDayInclusive = new Date(endOfDay.getTime() - 1);

    return {
        businessDate,
        startOfDay,
        endOfDay,
        endOfDayInclusive,
    };
}

/**
 * Parses and validates an optional date range in YYYY-MM-DD.
 * 
 * @param {string} [startDateStr]
 * @param {string} [endDateStr]
 * @returns {{ start: Date | null, end: Date | null, startDate: string | null, endDate: string | null }}
 */
function parseDateRange(startDateStr, endDateStr) {
    let start = null;
    let end = null;
    let startDate = null;
    let endDate = null;

    if (startDateStr) {
        startDate = String(startDateStr).trim();
        if (!isValidDateString(startDate)) {
            throw new Error(
                `Invalid startDate format: '${startDate}'. Expected YYYY-MM-DD.`
            );
        }
        start = new Date(`${startDate}T00:00:00+05:30`);
    }

    if (endDateStr) {
        endDate = String(endDateStr).trim();
        if (!isValidDateString(endDate)) {
            throw new Error(
                `Invalid endDate format: '${endDate}'. Expected YYYY-MM-DD.`
            );
        }
        // Exclusive boundary: start of the next day
        const endStart = new Date(`${endDate}T00:00:00+05:30`);
        end = new Date(endStart.getTime() + 24 * 60 * 60 * 1000);
    }

    if (start && end && start > end) {
        throw new Error("startDate cannot be after endDate.");
    }

    return {
        start,
        end,
        startDate,
        endDate,
    };
}

module.exports = {
    isValidDateString,
    getTodayIST,
    getBusinessDayRange,
    parseDateRange,
};
