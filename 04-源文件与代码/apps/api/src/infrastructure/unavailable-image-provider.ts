import type { CreateTaskInput } from "@photo-ai/contracts";
import type {
  ImageProvider,
  ProviderCandidate
} from "../application/task-service.js";

export class UnavailableImageProvider implements ImageProvider {
  public async runPreview(
    _input: CreateTaskInput,
    _attempt: 1 | 2
  ): Promise<ProviderCandidate> {
    throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
  }
}
