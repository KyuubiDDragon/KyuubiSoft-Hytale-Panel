/**
 * Formats raw item paths from the Hytale server into user-friendly display names.
 *
 * Handles formats like:
 * - "server.items.diamond_sword" -> "Diamond Sword"
 * - "hytale:diamond_sword" -> "Diamond Sword"
 * - "hytale:tools/pickaxe" -> "Pickaxe"
 * - "server.blocks.stone" -> "Stone"
 * - "server.entities.zombie" -> "Zombie"
 */

/**
 * Converts an item path or identifier to a human-readable name
 * @param path The raw item path (e.g., "server.items.diamond_sword" or "hytale:diamond")
 * @returns A formatted display name (e.g., "Diamond Sword" or "Diamond")
 */
export function formatItemPath(path: string): string {
  if (!path || typeof path !== 'string') {
    return path
  }

  let name = path

  // Handle "namespace:item/path" format (e.g., "hytale:tools/pickaxe")
  if (name.includes(':')) {
    // Remove namespace prefix
    name = name.split(':').pop() || name
    // Get the last segment if it's a path
    if (name.includes('/')) {
      name = name.split('/').pop() || name
    }
  }

  // Handle "namespace.category.item" format (e.g., "server.items.diamond_sword")
  if (name.includes('.')) {
    // Get the last segment
    name = name.split('.').pop() || name
  }

  // Convert snake_case or kebab-case to Title Case
  name = name
    .replace(/[_-]/g, ' ')  // Replace underscores and hyphens with spaces
    .replace(/\s+/g, ' ')   // Normalize multiple spaces
    .trim()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')

  return name
}

/**
 * Formats a console log message by replacing item paths with readable names
 * @param message The raw log message from the server
 * @returns The message with item paths converted to readable names
 */
export function formatLogMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return message
  }

  // Pattern for "server.items.item_name", "server.blocks.block_name", etc.
  const dotPattern = /\b(server|hytale|game)\.(items?|blocks?|entities?|tools?|weapons?|armor)\.([a-z][a-z0-9_]*)\b/gi

  // Pattern for "namespace:item/path" or "namespace:item_name"
  const colonPattern = /\b([a-z][a-z0-9_]*):([a-z][a-z0-9_/]*)\b/gi

  let result = message

  // Replace dot notation paths
  result = result.replace(dotPattern, (match, _namespace, _category, itemName) => {
    return formatItemPath(itemName)
  })

  // Replace colon notation paths (but preserve common non-item patterns like timestamps)
  result = result.replace(colonPattern, (match, namespace, itemPath) => {
    // Skip if it looks like a timestamp (e.g., "12:34:56")
    if (/^\d+$/.test(namespace)) {
      return match
    }
    // Skip common non-item namespaces
    const skipNamespaces = ['http', 'https', 'file', 'data', 'ws', 'wss']
    if (skipNamespaces.includes(namespace.toLowerCase())) {
      return match
    }
    return formatItemPath(match)
  })

  return result
}
