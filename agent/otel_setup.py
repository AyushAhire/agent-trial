"""
Agent Guardian - OTel bootstrap
Import this once at the top of your entrypoint (before agent_loop runs)
to send spans to a local OTel Collector -> SigNoz.
"""

import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

OTEL_COLLECTOR_ENDPOINT = os.environ.get("OTEL_COLLECTOR_ENDPOINT", "localhost:4317")

resource = Resource.create({"service.name": "agent-guardian"})
provider = TracerProvider(resource=resource)
exporter = OTLPSpanExporter(endpoint=OTEL_COLLECTOR_ENDPOINT, insecure=True)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

print(f"[otel] exporting spans to {OTEL_COLLECTOR_ENDPOINT}")
