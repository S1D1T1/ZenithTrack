/**
 * zenith.js - Zenith Tracker
 *
 * Given a geographic location (lat/lon) and the current time,
 * computes the RA/Dec of the point directly overhead (the zenith).
 *
 * The zenith declination equals the observer's latitude (always).
 * The zenith RA equals the Local Sidereal Time (LST).
 *
 * All angles in degrees internally. Output in conventional formats.
 */

/**
 * Compute Julian Date from a JavaScript Date object.
 * Standard formula from Meeus, "Astronomical Algorithms".
 */
export function julianDate(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const h = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600 + date.getUTCMilliseconds() / 3600000;

    let Y = y;
    let M = m;
    if (M <= 2) {
        Y -= 1;
        M += 12;
    }

    const A = Math.floor(Y / 100);
    const B = 2 - A + Math.floor(A / 4);

    return Math.floor(365.25 * (Y + 4716)) + Math.floor(30.6001 * (M + 1)) + d + h / 24 + B - 1524.5;
}

/**
 * Compute Greenwich Mean Sidereal Time (GMST) in degrees.
 * From the IAU 1982 model, accurate to ~0.1 second over decades.
 */
export function gmst(date) {
    const jd = julianDate(date);
    const T = (jd - 2451545.0) / 36525.0; // Julian centuries since J2000.0

    // GMST in seconds of time
    let gmstSeconds = 280.46061837
        + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * T * T
        - T * T * T / 38710000.0;

    // Normalize to 0-360
    gmstSeconds = ((gmstSeconds % 360) + 360) % 360;
    return gmstSeconds;
}

/**
 * Compute Local Sidereal Time in degrees.
 * LST = GMST + observer's longitude (east positive).
 */
export function lst(date, longitudeDeg) {
    const g = gmst(date);
    let local = g + longitudeDeg;
    return ((local % 360) + 360) % 360;
}

/**
 * Compute the zenith RA/Dec for a given location and time.
 * Returns { ra, dec } in degrees.
 *   ra: 0-360 (Right Ascension)
 *   dec: -90 to +90 (Declination = observer latitude)
 */
export function zenithPosition(date, latDeg, lonDeg) {
    return {
        ra: lst(date, lonDeg),
        dec: latDeg
    };
}

/**
 * Format RA (in degrees) as "HHh MMm SS.Ss"
 */
export function formatRA(raDeg) {
    const totalHours = raDeg / 15.0;
    const h = Math.floor(totalHours);
    const remainder = (totalHours - h) * 60;
    const m = Math.floor(remainder);
    const s = (remainder - m) * 60;
    return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`;
}

/**
 * Format Dec (in degrees) as "+DD° MM' SS""
 */
export function formatDec(decDeg) {
    const sign = decDeg >= 0 ? '+' : '-';
    const abs = Math.abs(decDeg);
    const d = Math.floor(abs);
    const remainder = (abs - d) * 60;
    const m = Math.floor(remainder);
    const s = (remainder - m) * 60;
    return `${sign}${String(d).padStart(2, '0')}\u00B0 ${String(m).padStart(2, '0')}\u2032 ${s.toFixed(0).padStart(2, '0')}\u2033`;
}
