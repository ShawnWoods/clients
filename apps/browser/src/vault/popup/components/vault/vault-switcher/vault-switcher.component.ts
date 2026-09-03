import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { Router } from "@angular/router";
import { switchMap } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { OrganizationId } from "@bitwarden/common/types/guid";
import {
  IconModule,
  IconTileComponent,
  IconTileOptions,
  MenuModule,
  TypographyModule,
} from "@bitwarden/components";
import { I18nPipe } from "@bitwarden/ui-common";
import {
  ALL_ITEMS_SCOPE,
  MY_VAULT_ROUTE,
  navIconTile,
  VAULT_BASE_ROUTE,
  VaultNavItemType,
  VaultNavItemViewModel,
  VaultNavService,
  type VaultScope,
  VaultScopeType,
  vaultScopeCommands,
} from "@bitwarden/vault";

import { VaultPopupListTableFiltersService } from "../../../services/vault-popup-list-table-filters.service";
import { VaultPopupScrollPositionService } from "../../../services/vault-popup-scroll-position.service";

/** A menu entry: one of the account's vaults, or the unscoped "All items" entry. */
interface VaultSwitcherEntry {
  /** The `:vaultId` segment, or `null` for All items. */
  id: string | null;
  label: string;
  tile: IconTileOptions;
}

/**
 * Vault switcher for the extension popup's title bar.
 *
 * Navigates to the scoped vault route rather than holding a selection of its own,
 * so the popup router cache restores the vault on reopen.
 * The page reads the scope back off `:vaultId` — see `VaultComponent.vaultScope`.
 */
@Component({
  selector: "app-vault-switcher",
  templateUrl: "vault-switcher.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [I18nPipe, IconModule, IconTileComponent, MenuModule, TypographyModule],
})
export class VaultSwitcherComponent {
  private readonly router = inject(Router);
  private readonly accountService = inject(AccountService);
  private readonly vaultNavService = inject(VaultNavService);
  private readonly basePath = inject(VAULT_BASE_ROUTE);
  private readonly listFiltersService = inject(VaultPopupListTableFiltersService);
  private readonly scrollPositionService = inject(VaultPopupScrollPositionService);

  /**
   * Whether the menu is open, for the chevron's highlight. Held here rather than read off
   * `aria-expanded`, which the directive clears without change detection.
   */
  protected readonly menuOpen = signal(false);

  /** The scope the page resolved from the route. */
  readonly scope = input<VaultScope | null>(ALL_ITEMS_SCOPE);

  private readonly nav = toSignal(
    this.accountService.activeAccount$.pipe(
      getUserId,
      switchMap((userId) => this.vaultNavService.viewModel$(userId)),
    ),
  );

  /**
   * The vaults to switch between, led by All items. Empty for a lone reachable vault, since every
   * entry would resolve to the same items. Tiles come from the shared `navIconTile`.
   */
  protected readonly entries = computed((): VaultSwitcherEntry[] => {
    const nav = this.nav();
    if (nav == null || nav.vaults.length < 2) {
      return [];
    }

    return [
      {
        id: null,
        label: "allItems",
        tile: { icon: "bwi-list", variant: "brand", emphasis: "bold" },
      },
      ...nav.vaults.map((vault) => ({
        id: this.segmentFor(vault),
        label: vault.label,
        tile: navIconTile(vault),
      })),
    ];
  });

  /** The selected entry's id, or `null` for All items. */
  protected readonly selectedId = computed((): string | null => {
    const scope = this.scope();
    if (scope == null || scope.type === VaultScopeType.AllItems) {
      return null;
    }
    if (scope.type === VaultScopeType.MyVault) {
      return MY_VAULT_ROUTE;
    }
    return scope.type === VaultScopeType.Organization ? scope.organizationId : null;
  });

  /** The trigger's entry — the selected vault, or All items. */
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return this.entries().find((entry) => entry.id === id) ?? null;
  });

  protected select(id: string | null): void {
    // Drop chips that name something in the vault being left. Cleared from the user's action, not
    // the scope publish it causes — that also fires on popup open.
    if (id != null) {
      this.listFiltersService.clearVaultScopedFilters();
    }

    // A different vault is a different list, so the offset names nothing in it. The route is not
    // reused, so the rebuilt page would otherwise restore the previous vault's offset.
    this.scrollPositionService.stop(true);

    void this.router.navigate(this.commandsFor(id), {
      // The scoped vault is the same page narrowed, not a step to return from.
      replaceUrl: true,
    });
  }

  /** The `:vaultId` segment naming a nav entry's vault. */
  private segmentFor(vault: VaultNavItemViewModel): string {
    return vault.type === VaultNavItemType.Personal ? MY_VAULT_ROUTE : vault.id;
  }

  /** The route commands for an entry, on the path this client mounts the vault at. */
  private commandsFor(id: string | null): string[] {
    return vaultScopeCommands(this.scopeFor(id), this.basePath);
  }

  /** The scope a menu entry names: All items, the personal vault, or an organization's. */
  private scopeFor(id: string | null): VaultScope {
    if (id == null) {
      return ALL_ITEMS_SCOPE;
    }
    return id === MY_VAULT_ROUTE
      ? { type: VaultScopeType.MyVault }
      : { type: VaultScopeType.Organization, organizationId: id as OrganizationId };
  }
}
