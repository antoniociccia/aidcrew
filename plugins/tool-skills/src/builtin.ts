import type { Skill } from '@aidcrew/core'
import decisionLab from '../skills/decision-lab/SKILL.md' with { type: 'text' }

const name = 'decision-lab'
const path = `aidcrew:skill/${name}`
const description = decisionLab.match(/^description: (.+)$/m)?.[1]
if (!description) throw new Error('Bundled Decision Lab description is missing')

export const builtinSkills: readonly Skill[] = [{ name, description, path }]

export function builtinBody(skill: Skill): string | undefined {
  return skill.name === name && skill.path === path ? decisionLab : undefined
}

export function withBuiltinSkills(skills: Skill[]): Skill[] {
  return [...new Map([...builtinSkills, ...skills].map((skill) => [skill.name, skill])).values()]
}
