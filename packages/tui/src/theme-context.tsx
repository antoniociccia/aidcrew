import { createContext, useContext } from 'react'
import type { Theme } from './theme.ts'
import { DEFAULT_THEME } from './theme.ts'

/**
 * The theme in force, so no component has to be handed one.
 *
 * A context rather than props because every component needs colours and none
 * of them need to choose: threading a theme through twenty components makes
 * the theme look like a parameter, which invites passing a different one.
 */
const ThemeContext = createContext<Theme>(DEFAULT_THEME)

export const ThemeProvider = ThemeContext.Provider

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

/**
 * Looks up the colour an agent keeps for the whole session.
 *
 * Returns a function rather than a colour because a component usually paints
 * several agents, and calling a hook per agent is not allowed.
 */
export function useVoice(): (index: number) => string {
  const theme = useTheme()
  return (index) => theme.voices[index % theme.voices.length] ?? theme.accent
}
