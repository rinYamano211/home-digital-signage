import type {
  QuotaAttempt,
  QuotaRepository,
} from "../../storage/quota-repository.js";
declare const permitBrand: unique symbol;
export interface SendPermit {
  readonly [permitBrand]: true;
}
export interface PermitBinding {
  provider: string;
  attempt: QuotaAttempt;
  repository: QuotaRepository;
  sequence: number;
  epoch: bigint;
}
/** Only the Gate's synchronous start path issues and consumes these objects. */
export class PermitRegistry {
  private readonly records = new WeakMap<SendPermit, PermitBinding>();
  issue(binding: PermitBinding): SendPermit {
    const permit = Object.freeze(Object.create(null)) as SendPermit;
    this.records.set(permit, { ...binding });
    return permit;
  }
  consume(permit: SendPermit, binding: PermitBinding): boolean {
    const stored = this.records.get(permit);
    this.records.delete(permit); // attempted consumption is terminal, even mismatch
    return (
      !!stored &&
      stored.provider === binding.provider &&
      stored.attempt === binding.attempt &&
      stored.repository === binding.repository &&
      stored.sequence === binding.sequence &&
      stored.epoch === binding.epoch
    );
  }
}
