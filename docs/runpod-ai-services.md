# RunPod AI Services

TechPulse peut utiliser RunPod Serverless comme provider TTS prioritaire pour les podcasts.

## Variables Worker

Ajouter ces secrets/variables au Worker :

```bash
wrangler secret put RUNPOD_API_KEY
wrangler secret put RUNPOD_AI_ENDPOINT_ID
```

`RUNPOD_AI_ENDPOINT_ID` correspond a l'endpoint cree depuis `techpulse-ai-services`.

## Ordre TTS

```text
RunPod Kokoro
-> FastAPI Edge-TTS
-> OpenAI gpt-4o-mini-tts
```

Si RunPod n'est pas configure ou echoue, le comportement precedent reste disponible.

## Test

Apres deploiement du worker et configuration RunPod :

```bash
curl -X POST "https://techpulse-worker.bricebrain.workers.dev/podcasts/generate?sync=1" \
  -H "Authorization: Bearer $TECHPULSE_API_SECRET"
```
