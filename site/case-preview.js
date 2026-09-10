export function controlPreview(video, button, motion) {
  let visible = false
  let manual = null
  const label = (playing) => {
    button.textContent = playing ? 'Pause background' : 'Play background'
    button.setAttribute('aria-pressed', String(playing))
  }
  const update = () => {
    const playing = visible && (manual === true || (manual === null && !motion.matches))
    label(playing)
    if (playing) video.play().catch(() => label(false))
    else video.pause()
  }
  button.addEventListener('click', () => { manual = video.paused; update() })
  motion.addEventListener('change', () => { manual = null; update() })
  return { visible(value) { visible = value; update() } }
}

if (typeof document !== 'undefined') {
  const video = document.getElementById('skyforge-background')
  const button = document.querySelector('[data-case-toggle]')
  if (video && button) {
    const controller = controlPreview(video, button, matchMedia('(prefers-reduced-motion: reduce)'))
    const observer = new IntersectionObserver(entries => {
      controller.visible(entries.some(entry => entry.isIntersecting))
    }, { threshold: 0.15 })
    observer.observe(video)
  }
}
