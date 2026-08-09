const { getOutboundMode, outboundDisabledError } = require('./outboundPolicy')

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

const fixtureResponse = (env = process.env) => ({
  id: 'fixture-response',
  output_text: env.OPENAI_FIXTURE_TEXT || 'ИИ-интеграция работает в fixture-режиме; внешний вызов не выполнялся.',
  output: [],
})

const openAiRequest = async (payload, { env = process.env, fetchImpl = global.fetch } = {}) => {
  const mode = getOutboundMode('OPENAI', env)
  if (mode === 'disabled') throw outboundDisabledError('OpenAI')
  if (mode === 'fixture') return fixtureResponse(env)

  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY не настроен на сервере')
    error.status = 503
    throw error
  }

  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API вернул ошибку ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.details = data
    throw error
  }
  return data
}

module.exports = { OPENAI_RESPONSES_URL, fixtureResponse, openAiRequest }
