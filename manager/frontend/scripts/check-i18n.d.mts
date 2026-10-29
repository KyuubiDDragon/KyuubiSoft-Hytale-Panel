export function flatten(tree: Record<string, unknown>, prefix?: string, out?: Map<string, string>): Map<string, string>
export function compareKeys(flat: Record<string, Map<string, string>>): Record<string, string[]>
export function placeholders(message: string): string[]
export function comparePlaceholders(
  flat: Record<string, Map<string, string>>,
): Array<{ key: string; byLocale: Record<string, string> }>
export function collectUsedKeys(files: Array<{ path: string; text: string }>): {
  literal: Map<string, Set<string>>
  dynamic: Map<string, Set<string>>
}
export function findMissingKeys(
  used: { literal: Map<string, Set<string>>; dynamic: Map<string, Set<string>> },
  flat: Record<string, Map<string, string>>,
): Array<{ key: string; files: string[] }>
export function runChecks(): { flat: Record<string, Map<string, string>>; findings: string[] }
