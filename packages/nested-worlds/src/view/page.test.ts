import { describe, expect, it } from 'bun:test'

const read = (file: string) => Bun.file(new URL(file, import.meta.url)).text()

describe('viewer page', () => {
  it('should_never_turn_agent_text_into_markup', async () => {
    const code = await read('./page.js')
    for (const sink of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
    ]) {
      expect(code).not.toContain(sink)
    }
    expect(code).toContain('textContent')
  })

  it('should_parse_as_a_module_since_no_build_step_checks_it', async () => {
    const code = await read('./page.js')
    expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(code)).not.toThrow()
  })

  it('should_load_nothing_from_outside_its_own_origin', async () => {
    const html = await read('./page.html')
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('style=')
  })
})
