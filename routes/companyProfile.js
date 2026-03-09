const express = require('express')
const router = express.Router()
const {
  fetchCurrentCompanyLegalProfile,
  fetchCompanyLegalProfileHistory,
} = require('../utils/companyLegalProfiles')

router.get('/current', async (req, res) => {
  try {
    const profile = await fetchCurrentCompanyLegalProfile(undefined, req.query.effective_date || null)
    if (!profile) return res.status(404).json({ message: 'Профиль компании не найден' })
    res.json(profile)
  } catch (e) {
    console.error('GET /company-profile/current error:', e)
    res.status(500).json({ message: 'Ошибка загрузки профиля компании' })
  }
})

router.get('/history', async (_req, res) => {
  try {
    const history = await fetchCompanyLegalProfileHistory()
    res.json(history)
  } catch (e) {
    console.error('GET /company-profile/history error:', e)
    res.status(500).json({ message: 'Ошибка загрузки истории профилей компании' })
  }
})

module.exports = router
