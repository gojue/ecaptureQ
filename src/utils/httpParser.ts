import type { ParsedHttpData } from '@/types';

/**
 * Decode base64 string to text
 */
export function decodeBase64(base64: string): string {
  try {
    return atob(base64);
  } catch (error) {
    console.error('Failed to decode base64:', error);
    return '';
  }
}

/**
 * Parse raw HTTP data into structured format
 */
export function parseHttpData(rawData: string): ParsedHttpData {
  const lines = rawData.split('\r\n');
  const headers: Record<string, string> = {};
  
  if (lines.length === 0) {
    return { headers };
  }

  // Parse first line (request line or status line)
  const firstLine = lines[0];
  let method: string | undefined;
  let url: string | undefined;
  let statusCode: number | undefined;
  let statusText: string | undefined;

  if (firstLine.startsWith('HTTP/')) {
    // Response
    const parts = firstLine.split(' ');
    if (parts.length >= 2) {
      statusCode = parseInt(parts[1]);
      statusText = parts.slice(2).join(' ');
    }
  } else {
    // Request
    const parts = firstLine.split(' ');
    if (parts.length >= 2) {
      method = parts[0];
      url = parts[1];
    }
  }

  // Parse headers
  let headerEndIndex = 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      headerEndIndex = i;
      break;
    }
    
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  // Parse body
  let body: string | undefined;
  if (headerEndIndex < lines.length - 1) {
    body = lines.slice(headerEndIndex + 1).join('\r\n');
  }

  return {
    method,
    url,
    statusCode,
    statusText,
    headers,
    body,
  };
}

/**
 * Generate unique ID for packet
 */
export function generatePacketId(): string {
  return `packet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Format packet size for display
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get HTTP method color class
 */
export function getMethodColorClass(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'method-get';
    case 'POST':
      return 'method-post';
    case 'PUT':
      return 'method-put';
    case 'DELETE':
      return 'method-delete';
    case 'PATCH':
      return 'method-patch';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400';
  }
}

/**
 * Get HTTP status code color class
 */
export function getStatusColorClass(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 300) return 'status-2xx';
  if (statusCode >= 300 && statusCode < 400) return 'status-3xx';
  if (statusCode >= 400 && statusCode < 500) return 'status-4xx';
  if (statusCode >= 500) return 'status-5xx';
  return 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400';
}

/**
 * Check if device is mobile based on screen size
 */
export function isMobile(): boolean {
  return window.innerWidth < 768;
}

/**
 * Truncate text to specified length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}
