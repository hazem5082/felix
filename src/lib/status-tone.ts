import type { SemanticTone } from "@/components/ui/status-pill";

export function dealStatusTone(status: string): SemanticTone {
  switch (status) {
    case "approved":
      return "blue";
    case "executed":
      return "green";
    case "rejected":
      return "red";
    default:
      return "amber";
  }
}

export function vehicleStatusTone(status: string): SemanticTone {
  switch (status) {
    case "sold":
      return "green";
    case "reserved":
      return "amber";
    default:
      return "neutral";
  }
}
