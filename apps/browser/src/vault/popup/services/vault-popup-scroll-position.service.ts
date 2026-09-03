import { inject, Injectable } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router } from "@angular/router";
import { filter, fromEvent, Subscription } from "rxjs";

import { ScrollLayoutService } from "@bitwarden/components";
import { VAULT_BASE_ROUTE } from "@bitwarden/vault";

@Injectable({
  providedIn: "root",
})
export class VaultPopupScrollPositionService {
  private router = inject(Router);
  private readonly scrollLayout = inject(ScrollLayoutService);

  /** Path of the vault screen */
  private readonly vaultPath = inject(VAULT_BASE_ROUTE);

  /** Current scroll position relative to the top of the viewport. */
  private scrollPosition: number | null = null;

  /** Subscription associated with the virtual scroll element. */
  private scrollSubscription: Subscription | null = null;

  /**
   * Where a restore in flight left the element, or `null` when none is. A scroll event that finds
   * the element still there belongs to the restore rather than to the user — see {@link start}.
   */
  private restoredTo: number | null = null;

  constructor() {
    this.router.events
      .pipe(
        takeUntilDestroyed(),
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      )
      .subscribe((event) => {
        this.resetListenerForNavigation(event);
      });
  }

  /** Scrolls the user to the stored scroll position and starts tracking scroll of the page. */
  start(scrollElement: HTMLElement) {
    const restoring = this.hasScrollPosition();
    const target = this.scrollPosition;

    if (restoring) {
      // Declared before the jump paints, so collapsing chrome arrives collapsed rather than
      // animating once the offset lands. Corrected below from where the jump actually went.
      this.scrollLayout.restoredScrolled.set(target! > 0);

      // Use `setTimeout` to scroll after rendering is complete
      setTimeout(() => {
        scrollElement.scrollTo({ top: target!, behavior: "instant" });
        // Declared from where the jump actually landed, not from whether one was attempted. The
        // vault attaches twice — `popup-page`'s region first, then the table's viewport once its
        // rows render — and the first element never scrolls, so a restore onto it lands at 0.
        // Reading the result keeps the last attach authoritative whichever order they settle in,
        // and a stored 0 still resolves to false. A clamped restore lands short of the target, so
        // this is the offset the guard below compares against.
        this.restoredTo = scrollElement.scrollTop;
        this.scrollLayout.restoredScrolled.set(scrollElement.scrollTop > 0);
      });
    }

    this.scrollSubscription?.unsubscribe();

    this.restoredTo = restoring ? target : null;

    this.scrollSubscription = fromEvent(scrollElement, "scroll").subscribe(() => {
      // Decided from the offset rather than from elapsed time: `scrollTo` updates `scrollTop`
      // synchronously but the event waits for the next rendering update, so a timer meant to
      // outlast it usually expires first — and the restore's own event then read as the user's,
      // releasing the collapsed chrome the restore had just declared. An event that leaves the
      // element where the restore put it belongs to the restore, however many arrive.
      if (this.restoredTo != null && scrollElement.scrollTop === this.restoredTo) {
        return;
      }

      this.restoredTo = null;
      this.scrollLayout.restoredScrolled.set(false);
      this.scrollPosition = scrollElement.scrollTop;
    });
  }

  /** Stops the scroll listener from updating the stored location. */
  stop(reset?: true) {
    this.scrollSubscription?.unsubscribe();
    this.scrollSubscription = null;
    this.restoredTo = null;
    this.scrollLayout.restoredScrolled.set(false);

    if (reset) {
      this.scrollPosition = null;
    }
  }

  /** Returns true when a scroll position has been stored. */
  hasScrollPosition() {
    return this.scrollPosition !== null;
  }

  /** Conditionally resets the scroll listeners based on the ending path of the navigation */
  private resetListenerForNavigation(event: NavigationEnd): void {
    // The vault page is the target of the scroll listener, return early
    if (this.isVaultUrl(event.url)) {
      return;
    }

    // For all other tab pages reset the scroll position
    if (event.url.startsWith("/tabs/")) {
      this.stop(true);
    }
  }

  private isVaultUrl(url: string): boolean {
    const path = url.split("?")[0].split("#")[0];
    return path === this.vaultPath || path.startsWith(`${this.vaultPath}/`);
  }
}
