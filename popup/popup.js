/**
 * JobSwiper Extension — Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Check auth status
  const { token } = await chrome.storage.local.get('token')

  if (token) {
    document.body.classList.remove('logged-out')
    document.body.classList.add('logged-in')
  } else {
    document.body.classList.remove('logged-in')
    document.body.classList.add('logged-out')
  }

  // Logout button
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await chrome.storage.local.remove('token')
    document.body.classList.remove('logged-in')
    document.body.classList.add('logged-out')
  })
})
