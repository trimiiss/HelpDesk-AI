{{- define "helpdesk.labels" -}}
app.kubernetes.io/part-of: helpdesk
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Labels that select one component. Usage: include "helpdesk.selector" "call-gateway" */}}
{{- define "helpdesk.selector" -}}
app.kubernetes.io/name: {{ . }}
app.kubernetes.io/instance: helpdesk
{{- end }}

{{/* Usage: include "helpdesk.image" (dict "root" . "name" "call-gateway") */}}
{{- define "helpdesk.image" -}}
{{ .root.Values.image.registry }}/{{ .name }}:{{ .root.Values.image.tag }}
{{- end }}

{{- define "helpdesk.secretName" -}}
{{ .Values.secrets.existingSecret | default "helpdesk-secrets" }}
{{- end }}

{{/* The same locked-down settings for every container of ours. */}}
{{- define "helpdesk.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
capabilities:
  drop:
    - ALL
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "helpdesk.podSecurity" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/* Tells Prometheus to scrape the metrics port of this pod. */}}
{{- define "helpdesk.scrapeAnnotations" -}}
prometheus.io/scrape: "true"
prometheus.io/port: "9464"
prometheus.io/path: /metrics
{{- end }}

{{- define "helpdesk.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "helpdesk.secretName" .root }}
      key: {{ .name }}
{{- end }}

{{- define "helpdesk.embeddingEnv" -}}
- name: EMBEDDING_PROVIDER
  value: {{ .Values.embedding.provider | quote }}
- name: EMBEDDING_MODEL
  value: {{ .Values.embedding.model | quote }}
{{- if .Values.embedding.openaiBaseUrl }}
- name: OPENAI_BASE_URL
  value: {{ .Values.embedding.openaiBaseUrl | quote }}
{{- end }}
{{ include "helpdesk.secretEnv" (dict "root" . "name" "OPENAI_API_KEY") }}
{{- end }}

{{- define "helpdesk.otelEnv" -}}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: http://{{ .Release.Name }}-opentelemetry-collector:4318
{{- end }}

{{/* A NetworkPolicy peer that matches one component. */}}
{{- define "helpdesk.peer" -}}
- podSelector:
    matchLabels:
      app.kubernetes.io/name: {{ . }}
{{- end }}
