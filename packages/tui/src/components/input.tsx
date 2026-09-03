import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme-context.tsx'
import { keystroke } from './keystroke.ts'

/**
 * A single-line text field.
 *
 * Written here rather than taken from a package for one reason: the secret
 * variant below has to guarantee that what is typed never reaches the screen,
 * and that guarantee is only worth as much as the code you can read.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  isActive = true,
  /** Replaces every character on screen. Set for anything secret. */
  mask,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  placeholder?: string
  isActive?: boolean
  mask?: string
}) {
  const theme = useTheme()

  useInput(
    (input, key) => {
      // What a keypress means lives next door, where it can be tested without
      // a terminal — which is how the field came to refuse the one character
      // a feature for naming files with `@` depends on.
      const stroke = keystroke(value, input, key)
      if (stroke.at === 'submit') onSubmit?.(value)
      if (stroke.at === 'text') onChange(stroke.value)
    },
    { isActive },
  )

  const shown = mask ? mask.repeat(value.length) : value

  return (
    <Text>
      {value === '' ? <Text color={theme.muted}>{placeholder}</Text> : <Text>{shown}</Text>}
      {isActive ? <Text color={theme.accent}>▏</Text> : null}
    </Text>
  )
}

/**
 * A field for an API key.
 *
 * What is typed is replaced on screen, character for character, and is never
 * rendered anywhere else: keys get read over shoulders, caught in screen
 * recordings and pasted into bug reports, and none of that needs to be
 * possible.
 */
export function SecretInput({
  value,
  onChange,
  onSubmit,
  isActive = true,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  isActive?: boolean
}) {
  const theme = useTheme()

  return (
    <Box>
      <TextInput
        value={value}
        onChange={onChange}
        {...(onSubmit ? { onSubmit } : {})}
        placeholder="paste or type the key"
        isActive={isActive}
        mask="•"
      />
      {value.length > 0 ? <Text color={theme.muted}> {value.length} characters</Text> : null}
    </Box>
  )
}

/** A labelled field, for forms. */
export function Field({
  label,
  focused,
  children,
}: {
  label: string
  focused?: boolean
  children: React.ReactNode
}) {
  const theme = useTheme()

  return (
    <Box>
      <Box width={16}>
        <Text color={focused ? theme.accent : theme.muted}>{label}</Text>
      </Box>
      {children}
    </Box>
  )
}
