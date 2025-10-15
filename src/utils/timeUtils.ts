/**
 * Utility functions for handling timestamps
 */

/**
 * Format timestamp to readable string with high precision
 * Automatically detects timestamp format (seconds, milliseconds, microseconds, or nanoseconds)
 * @param timestamp - The timestamp to format
 * @param options - Formatting options
 * @returns Formatted time string with microsecond precision
 */
export function formatTimestamp(
  timestamp: number, 
  options: {
    includeDate?: boolean;
    locale?: string;
    showMicroseconds?: boolean;
  } = {}
): string {
  try {
    if (!timestamp || isNaN(timestamp) || timestamp <= 0) {
      return 'Invalid timestamp';
    }

    const { includeDate = false, locale = 'zh-CN', showMicroseconds = true } = options;
    
    // Convert timestamp to milliseconds and extract sub-millisecond precision
    let timestampMs: number;
    let microseconds = 0;
    
    if (timestamp > 1e15) {
      // Nanoseconds (e.g., 1760495631914807673)
      timestampMs = Math.floor(timestamp / 1e6);
      microseconds = Math.floor((timestamp % 1e6) / 1e3); // Extract microseconds part
    } else if (timestamp > 1e12) {
      // Microseconds  
      timestampMs = Math.floor(timestamp / 1e3);
      microseconds = timestamp % 1e3;
    } else if (timestamp > 1e9) {
      // Milliseconds
      timestampMs = timestamp;
      microseconds = 0;
    } else {
      // Seconds
      timestampMs = timestamp * 1000;
      microseconds = 0;
    }

    const date = new Date(timestampMs);
    
    if (isNaN(date.getTime())) {
      return 'Invalid date';
    }

    const formatOptions: Intl.DateTimeFormatOptions = {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    };

    if (includeDate) {
      formatOptions.year = 'numeric';
      formatOptions.month = '2-digit';
      formatOptions.day = '2-digit';
    }

    let baseTime = includeDate 
      ? date.toLocaleString(locale, formatOptions)
      : date.toLocaleTimeString(locale, formatOptions);
    
    // Add microsecond precision if available and requested
    if (showMicroseconds && microseconds > 0) {
      baseTime += `.${microseconds.toString().padStart(3, '0')}`;
    }

    return baseTime;
      
  } catch (error) {
    console.error('Timestamp formatting error:', error);
    return 'Format error';
  }
}

/**
 * Format timestamp with full nanosecond precision display
 * @param timestamp - The nanosecond timestamp to format
 * @param options - Formatting options
 * @returns Formatted time string with nanosecond precision
 */
export function formatHighPrecisionTimestamp(
  timestamp: number, 
  options: {
    includeDate?: boolean;
    locale?: string;
  } = {}
): string {
  try {
    if (!timestamp || isNaN(timestamp) || timestamp <= 0) {
      return 'Invalid timestamp';
    }

    const { includeDate = false, locale = 'zh-CN' } = options;
    
    if (timestamp > 1e15) {
      // Nanosecond precision
      const timestampMs = Math.floor(timestamp / 1e6);
      const nanosecondRemainder = timestamp % 1e6;
      const microseconds = Math.floor(nanosecondRemainder / 1e3);
      const nanoseconds = nanosecondRemainder % 1e3;
      
      const date = new Date(timestampMs);
      
      if (isNaN(date.getTime())) {
        return 'Invalid date';
      }

      const formatOptions: Intl.DateTimeFormatOptions = {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      };

      if (includeDate) {
        formatOptions.year = 'numeric';
        formatOptions.month = '2-digit';
        formatOptions.day = '2-digit';
      }

      const baseTime = includeDate 
        ? date.toLocaleString(locale, formatOptions)
        : date.toLocaleTimeString(locale, formatOptions);
      
      return `${baseTime}.${microseconds.toString().padStart(3, '0')}${nanoseconds.toString().padStart(3, '0')}`;
    } else {
      // Fall back to regular formatting for non-nanosecond timestamps
      return formatTimestamp(timestamp, { includeDate, locale, showMicroseconds: true });
    }
      
  } catch (error) {
    console.error('High precision timestamp formatting error:', error);
    return 'Format error';
  }
}

/**
 * Convert timestamp to Date object
 * @param timestamp - The timestamp to convert
 * @returns Date object or null if invalid
 */
export function timestampToDate(timestamp: number): Date | null {
  try {
    if (!timestamp || isNaN(timestamp) || timestamp <= 0) {
      return null;
    }

    let timestampMs: number;
    
    if (timestamp > 1e15) {
      // Nanoseconds - convert to milliseconds
      timestampMs = Math.floor(timestamp / 1e6);
    } else if (timestamp > 1e12) {
      // Microseconds - convert to milliseconds
      timestampMs = Math.floor(timestamp / 1e3);
    } else if (timestamp > 1e9) {
      // Milliseconds
      timestampMs = timestamp;
    } else {
      // Seconds - convert to milliseconds
      timestampMs = timestamp * 1000;
    }

    const date = new Date(timestampMs);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.error('Timestamp conversion error:', error);
    return null;
  }
}