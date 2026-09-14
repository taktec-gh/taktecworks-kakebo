import type { PaymentSourceType } from "@/generated/prisma/enums";
import {
  canMovePaymentSource,
  sortPaymentSources,
  type PaymentSourceOrderItem,
} from "@/lib/payment-source-order";

import type { PaymentSourceFormAction } from "./action-state";
import { PaymentSourceRow } from "./payment-source-row";

/** 一覧表示に必要な項目。Prisma の PaymentSource はこれを満たす */
export type PaymentSourceListItem = PaymentSourceOrderItem & {
  name: string;
  type: PaymentSourceType;
  isDefault: boolean;
};

export type PaymentSourceListProps = {
  sources: readonly PaymentSourceListItem[];
  /** 通常は Server Action の movePaymentSourceAction を渡す */
  moveAction: PaymentSourceFormAction;
};

/**
 * 払い出し先の一覧。
 * 「有効」グループ → 「無効」グループの順に並べ、各グループ内は sortOrder 昇順。
 * 移動は同一グループ内のみで、端では該当ボタンを非活性にする。
 */
export function PaymentSourceList({ sources, moveAction }: PaymentSourceListProps) {
  const sorted = sortPaymentSources(sources);
  const active = sorted.filter((source) => source.isActive);
  const inactive = sorted.filter((source) => !source.isActive);

  if (sorted.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/20 px-4 py-6 text-center text-sm opacity-70 dark:border-white/25">
        払い出し先がまだありません。下のフォームから追加してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">有効</h2>
        {active.length === 0 ? (
          <p className="text-sm opacity-70">有効な払い出し先がありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {active.map((source) => (
              <PaymentSourceRow
                key={source.id}
                id={source.id}
                name={source.name}
                type={source.type}
                isActive={source.isActive}
                isDefault={source.isDefault}
                canMoveUp={canMovePaymentSource(sorted, source.id, "up")}
                canMoveDown={canMovePaymentSource(sorted, source.id, "down")}
                moveAction={moveAction}
              />
            ))}
          </ul>
        )}
      </section>

      {inactive.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold opacity-70">無効</h2>
          <ul className="flex flex-col gap-2">
            {inactive.map((source) => (
              <PaymentSourceRow
                key={source.id}
                id={source.id}
                name={source.name}
                type={source.type}
                isActive={source.isActive}
                isDefault={source.isDefault}
                canMoveUp={canMovePaymentSource(sorted, source.id, "up")}
                canMoveDown={canMovePaymentSource(sorted, source.id, "down")}
                moveAction={moveAction}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
