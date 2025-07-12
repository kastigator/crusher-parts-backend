const express = require('express')
const fs = require('fs')
const path = require('path')

const router = express.Router()

router.post('/generate-component', async (req, res) => {
  const { name } = req.body

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ message: 'Некорректное имя компонента' })
  }

  const filename = name.replace(/[^a-zA-Z0-9]/g, '')
  const filePath = path.resolve(__dirname, '../../crusher-parts-frontend/src/pages', `${filename}.jsx`)

  const content = `
import React from 'react'
import { Box, Typography } from '@mui/material'

const ${filename} = () => (
  <Box p={3}>
    <Typography variant="h6">Страница ${filename}</Typography>
    <Typography color="text.secondary">Этот компонент был создан автоматически.</Typography>
  </Box>
)

export default ${filename}
  `.trim()

  try {
    if (fs.existsSync(filePath)) {
      return res.status(400).json({ message: 'Файл уже существует' })
    }
    fs.writeFileSync(filePath, content)
    res.json({ message: 'Компонент создан' })
  } catch (err) {
    console.error('Ошибка при создании компонента:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router