# Models

The panel intentionally keeps the model list short.

| Label | Codex CLI model id | Good for |
| --- | --- | --- |
| GPT-5.5 | `gpt-5.5` | harder reasoning, code review, long notes |
| GPT-5.4 mini | `gpt-5.4-mini` | quick explanations, summaries, study help |
| GPT-5.3 Spark | `gpt-5.3-codex-spark` | fast short answers and lightweight prompts |

Model access can vary by account. Check your local CLI:

```bash
codex debug models
```

The plugin falls back to `gpt-5.5` if an old or unsupported model is saved in settings.
