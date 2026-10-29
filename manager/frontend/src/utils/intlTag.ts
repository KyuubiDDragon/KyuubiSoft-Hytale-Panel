/** BCP 47 tag for a panel language (the panel names Brazilian Portuguese `pt_br`). */
export function intlTag(locale: string): string {
  return locale === 'pt_br' ? 'pt-BR' : locale
}
