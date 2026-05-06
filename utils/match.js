/**
 * JobSwiper match-tier helper (shared across content scripts).
 *
 * Mirrors src/lib/matching/thresholds.ts:getMatchTier from the main app.
 * Cutoffs 75 / 50 / 30 stay in lock-step with the dashboard so a saved job
 * shows the same tier label and color in the extension overlay as it does
 * in the web app.
 */

;(function () {
  if (typeof window === 'undefined') return
  if (window.JobSwiperMatch) return

  const API_BASE = 'https://www.jobswiper.ai'

  const TIERS = {
    strong: {
      tier: 'strong',
      cutoff: 75,
      label: 'Excellent Match',
      bg: '#d1fae5', // emerald-100
      fg: '#065f46', // emerald-800
      ring: '#10b981', // emerald-500
      dot: '#10b981',
    },
    moderate: {
      tier: 'moderate',
      cutoff: 50,
      label: 'Good Match',
      bg: '#fef3c7', // amber-100
      fg: '#92400e', // amber-800
      ring: '#f59e0b', // amber-500
      dot: '#f59e0b',
    },
    low: {
      tier: 'low',
      cutoff: 30,
      label: 'Stretch Match',
      bg: '#ffedd5', // orange-100
      fg: '#9a3412', // orange-800
      ring: '#f97316', // orange-500
      dot: '#f97316',
    },
    careerPivot: {
      tier: 'career-pivot',
      cutoff: 0,
      label: 'Career Pivot',
      bg: '#ffe4e6', // rose-100
      fg: '#9f1239', // rose-800
      ring: '#f43f5e', // rose-500
      dot: '#f43f5e',
    },
  }

  function getMatchTier(score) {
    const s = Number.isFinite(score) ? score : 0
    if (s >= TIERS.strong.cutoff) return TIERS.strong
    if (s >= TIERS.moderate.cutoff) return TIERS.moderate
    if (s >= TIERS.low.cutoff) return TIERS.low
    return TIERS.careerPivot
  }

  /**
   * Set tier-correct text + colors on an inline score badge element.
   * Renders: "{score}% {Label}  Why?".
   */
  function applyMatchBadge(badge, score) {
    if (!badge) return
    const tier = getMatchTier(score)
    badge.textContent = ''
    badge.style.background = tier.bg
    badge.style.color = tier.fg
    badge.style.border = `1px solid ${tier.ring}33`
    badge.style.cursor = 'pointer'
    badge.dataset.jswScore = String(score)
    badge.dataset.jswTier = tier.tier
    badge.setAttribute('title', `${score}% — ${tier.label}. Click for details.`)

    const num = document.createElement('strong')
    num.textContent = `${score}%`
    num.style.cssText = 'font-weight:800;'

    const label = document.createElement('span')
    label.textContent = tier.label
    label.style.cssText = 'font-weight:600;'

    const why = document.createElement('span')
    why.className = 'jobswiper-why-link'
    why.textContent = 'Why?'
    why.style.cssText = `font-weight:600;text-decoration:underline;opacity:0.85;`

    const sep = () => {
      const s = document.createElement('span')
      s.textContent = ' · '
      s.style.opacity = '0.55'
      return s
    }

    badge.appendChild(num)
    badge.appendChild(sep())
    badge.appendChild(label)
    badge.appendChild(sep())
    badge.appendChild(why)
  }

  // ---------------------------------------------------------------------------
  // Popover
  // ---------------------------------------------------------------------------

  const AXIS_ORDER = ['skills', 'experience', 'jobType', 'location', 'industry', 'companySize']
  const AXIS_LABEL = {
    skills: 'Skills',
    experience: 'Experience',
    jobType: 'Contract type',
    location: 'Location',
    industry: 'Industry',
    companySize: 'Company size',
  }

  function escHtml(str) {
    const d = document.createElement('div')
    d.textContent = str == null ? '' : String(str)
    return d.innerHTML
  }

  let _openPopover = null
  let _outsideHandler = null
  let _repositionHandler = null
  let _openAnchor = null

  function closePopover() {
    if (_openPopover && _openPopover.parentElement) _openPopover.remove()
    _openPopover = null
    _openAnchor = null
    if (_outsideHandler) {
      document.removeEventListener('mousedown', _outsideHandler, true)
      _outsideHandler = null
    }
    if (_repositionHandler) {
      window.removeEventListener('scroll', _repositionHandler, true)
      window.removeEventListener('resize', _repositionHandler, true)
      _repositionHandler = null
    }
  }

  function positionPopover(popover, anchor) {
    const rect = anchor.getBoundingClientRect()
    const pw = popover.offsetWidth || 360
    const ph = popover.offsetHeight || 360
    const margin = 8
    let top = rect.bottom + margin
    let left = rect.left
    // Flip up if no room below
    if (top + ph > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - ph - margin)
    }
    // Clamp to viewport horizontally
    if (left + pw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - pw - margin)
    }
    if (left < margin) left = margin
    popover.style.top = `${Math.round(top)}px`
    popover.style.left = `${Math.round(left)}px`
  }

  function buildAxisRow(axisKey, axisData) {
    const row = document.createElement('div')
    row.className = 'jobswiper-axis-row'

    const head = document.createElement('div')
    head.className = 'jobswiper-axis-head'
    const label = document.createElement('span')
    label.className = 'jobswiper-axis-label'
    label.textContent = AXIS_LABEL[axisKey] || axisKey
    head.appendChild(label)
    row.appendChild(head)

    if (axisData?.summary) {
      const summary = document.createElement('p')
      summary.className = 'jobswiper-axis-summary'
      summary.textContent = axisData.summary
      row.appendChild(summary)
    }

    if (axisKey === 'skills' && (axisData?.matched?.length || axisData?.missing?.length)) {
      const chips = document.createElement('div')
      chips.className = 'jobswiper-axis-chips'
      ;(axisData.matched || []).slice(0, 6).forEach((s) => {
        const c = document.createElement('span')
        c.className = 'jobswiper-chip matched'
        c.textContent = `✓ ${s}`
        chips.appendChild(c)
      })
      ;(axisData.missing || []).slice(0, 4).forEach((s) => {
        const c = document.createElement('span')
        c.className = 'jobswiper-chip missing'
        c.textContent = s
        chips.appendChild(c)
      })
      row.appendChild(chips)
    }

    if (axisKey === 'experience' && axisData?.citation) {
      const cite = document.createElement('p')
      cite.className = 'jobswiper-axis-citation'
      cite.textContent = `“${axisData.citation}”`
      row.appendChild(cite)
    }

    if (axisData?.tip) {
      const tipBox = document.createElement('div')
      tipBox.className = 'jobswiper-axis-tip'
      const tipLabel = document.createElement('span')
      tipLabel.className = 'jobswiper-axis-tip-label'
      tipLabel.textContent = 'Tip'
      const tipText = document.createElement('span')
      tipText.textContent = axisData.tip
      tipBox.appendChild(tipLabel)
      tipBox.appendChild(tipText)
      row.appendChild(tipBox)
    }

    return row
  }

  function buildPopoverContent(score, data) {
    const tier = getMatchTier(score)
    const root = document.createElement('div')
    root.className = 'jobswiper-axis-popover'
    root.setAttribute('role', 'dialog')

    const header = document.createElement('div')
    header.className = 'jobswiper-axis-header'
    header.style.background = `linear-gradient(135deg, ${tier.bg}, transparent)`

    const title = document.createElement('div')
    title.className = 'jobswiper-axis-title'

    const dot = document.createElement('span')
    dot.className = 'jobswiper-axis-dot'
    dot.style.background = tier.dot

    const titleText = document.createElement('div')
    titleText.innerHTML = `<div class="jobswiper-axis-title-main">Why this score?</div>
      <div class="jobswiper-axis-title-sub"><strong>${score}</strong> / 100 · <span style="color:${tier.fg}">${escHtml(tier.label)}</span></div>`

    title.appendChild(dot)
    title.appendChild(titleText)

    const close = document.createElement('button')
    close.className = 'jobswiper-axis-close'
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    close.textContent = '×'
    close.addEventListener('click', (e) => { e.stopPropagation(); closePopover() })

    header.appendChild(title)
    header.appendChild(close)
    root.appendChild(header)

    const body = document.createElement('div')
    body.className = 'jobswiper-axis-body'

    const explanations = data && data.axis_explanations
    if (!explanations) {
      const empty = document.createElement('div')
      empty.className = 'jobswiper-axis-empty'
      const headline = document.createElement('div')
      headline.className = 'jobswiper-axis-empty-title'
      headline.textContent = data && data.already_saved
        ? 'Generating your personalised explanation'
        : 'Save the job to see why'
      const sub = document.createElement('p')
      sub.className = 'jobswiper-axis-empty-sub'
      sub.textContent = data && data.already_saved
        ? 'Open the job in your dashboard to trigger the AI explanation. We cache it the first time you view the detail page.'
        : 'Once saved, the AI breaks the score down into 6 axes (skills, experience, contract, location, industry, company size) with tips you can act on.'
      const cta = document.createElement('a')
      cta.className = 'jobswiper-axis-cta'
      cta.href = `${API_BASE}/dashboard/jobs`
      cta.target = '_blank'
      cta.rel = 'noopener'
      cta.textContent = data && data.already_saved ? 'Open dashboard' : 'Open JobSwiper'
      empty.appendChild(headline)
      empty.appendChild(sub)
      empty.appendChild(cta)
      body.appendChild(empty)
    } else {
      AXIS_ORDER.forEach((axis) => {
        const axisData = explanations[axis]
        if (!axisData) return
        body.appendChild(buildAxisRow(axis, axisData))
      })
    }

    root.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'jobswiper-axis-footer'
    const link = document.createElement('a')
    link.href = `${API_BASE}/dashboard/jobs`
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'Open in dashboard →'
    footer.appendChild(link)
    root.appendChild(footer)

    return root
  }

  /**
   * Make `badge` toggle a popover with axis explanations on click.
   * `data` is the analyze-job response (or `null` if the call failed).
   */
  function attachExplanationPopover(badge, score, data) {
    if (!badge) return
    badge.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      // Toggle: clicking the same badge closes the popover.
      if (_openPopover && _openPopover.dataset.jswOwner === badge.dataset.jswOwnerId) {
        closePopover()
        return
      }
      closePopover()

      const popover = buildPopoverContent(score, data)
      const ownerId = `jsw-${Math.random().toString(36).slice(2, 9)}`
      badge.dataset.jswOwnerId = ownerId
      popover.dataset.jswOwner = ownerId
      document.body.appendChild(popover)
      // Position after layout (need offsetWidth/Height).
      requestAnimationFrame(() => positionPopover(popover, badge))
      _openPopover = popover
      _openAnchor = badge

      _outsideHandler = (ev) => {
        if (!_openPopover) return
        if (_openPopover.contains(ev.target) || badge.contains(ev.target)) return
        closePopover()
      }
      _repositionHandler = () => {
        if (!_openPopover || !_openAnchor) return
        // If the anchor scrolled out of view, close. Otherwise reposition.
        const rect = _openAnchor.getBoundingClientRect()
        const offscreen = rect.bottom < 0 || rect.top > window.innerHeight ||
          rect.right < 0 || rect.left > window.innerWidth
        if (offscreen) { closePopover(); return }
        positionPopover(_openPopover, _openAnchor)
      }
      // capture-phase so SPA frameworks can't swallow it.
      document.addEventListener('mousedown', _outsideHandler, true)
      window.addEventListener('scroll', _repositionHandler, true)
      window.addEventListener('resize', _repositionHandler, true)
    })
  }

  window.JobSwiperMatch = {
    getMatchTier,
    applyMatchBadge,
    attachExplanationPopover,
    closePopover,
  }
})()
