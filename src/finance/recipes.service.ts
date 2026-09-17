import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StockMovementReason, StockMovementType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { restaurantContext } from '../common/context/restaurant-context';
import { AppException, ERROR_CODES } from '../common/exceptions/app.exception';
import type { AuthenticatedUser, RequestContext } from '../common/types/authenticated-user';
import { toWire } from '../common/utils/wire-enum.util';
import { PrismaService } from '../database/prisma.service';
import type { SaveRecipeDto } from './dto/recipe.dto';
import { StockService } from './stock.service';

/**
 * La maison dont on lit ou saisit la fiche technique.
 *
 * La carte est commune, mais chaque maison a **son** stock : un même plat a
 * donc une fiche par maison, chaque ligne pointant vers un article de la
 * réserve de cette maison. Sans maison désignée — le propriétaire en vue
 * d'ensemble —, il n'y a pas de fiche à montrer : additionner les deux
 * réserves doublerait le coût de revient.
 */
function maisonExigee(): string {
  const restaurantId = restaurantContext.activeRestaurantId();
  if (!restaurantId) {
    throw AppException.badRequest(
      ERROR_CODES.VALIDATION_ERROR,
      'Choisissez un établissement en haut de la page : chaque maison a sa propre fiche technique, faite de son stock.',
    );
  }
  return restaurantId;
}

const RECIPE_INCLUDE = {
  stockItem: {
    select: { id: true, name: true, unit: true, quantity: true, averageCost: true },
  },
} satisfies Prisma.RecipeIngredientInclude;

type RecipeLine = Prisma.RecipeIngredientGetPayload<{ include: typeof RECIPE_INCLUDE }>;

/** Une portion consommée, telle qu'elle sera sortie de la réserve. */
interface Consumption {
  stockItemId: string;
  name: string;
  quantity: number;
}

/**
 * Fiches techniques.
 *
 * C'est le chaînon qui referme le circuit de la matière : l'achat la fait
 * entrer en réserve, la fiche technique dit ce qu'un plat en prélève, et la
 * mise en préparation d'une commande l'en sort. Sans elle, le stock ne
 * faisait que monter.
 *
 * Elle donne aussi le **coût de revient** d'un plat — la somme de ses
 * ingrédients valorisés au coût moyen pondéré — et donc sa marge réelle,
 * qui n'a rien à voir avec son prix de vente affiché.
 */
@Injectable()
export class RecipesService {
  private readonly logger = new Logger(RecipesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  // ──────────────────────────── Consultation ──────────────────────────────

  /** Fiche technique d'un plat, avec son coût et sa marge. */
  async findForMenuItem(menuItemId: string) {
    const menuItem = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null },
      select: { id: true, name: true, price: true, promoPrice: true },
    });
    if (!menuItem) throw AppException.notFound('Plat introuvable.');
    const restaurantId = maisonExigee();

    const lines = await this.prisma.recipeIngredient.findMany({
      where: { menuItemId, stockItem: { restaurantId } },
      include: RECIPE_INCLUDE,
      orderBy: { stockItem: { name: 'asc' } },
    });

    return this.toDto(menuItem, lines);
  }

  /**
   * Coût de revient de plusieurs plats en une fois.
   *
   * La liste de la carte affiche une marge par ligne : la calculer plat par
   * plat ferait une requête par ligne affichée.
   */
  async costsFor(menuItemIds: string[]): Promise<Map<string, number>> {
    if (menuItemIds.length === 0) return new Map();

    // En vue d'ensemble, pas de marge : additionner les fiches des deux
    // maisons compterait deux fois la matière d'un même plat.
    const restaurantId = restaurantContext.activeRestaurantId();
    if (!restaurantId) return new Map();

    const lines = await this.prisma.recipeIngredient.findMany({
      where: { menuItemId: { in: menuItemIds }, stockItem: { restaurantId } },
      include: RECIPE_INCLUDE,
    });

    const costs = new Map<string, number>();
    for (const line of lines) {
      const current = costs.get(line.menuItemId) ?? 0;
      costs.set(line.menuItemId, current + line.quantity * line.stockItem.averageCost);
    }

    for (const [id, value] of costs) costs.set(id, Math.round(value));
    return costs;
  }

  // ──────────────────────────── Modification ──────────────────────────────

  /**
   * Remplace la fiche d'un plat.
   *
   * L'enregistrement est intégral, pas ligne à ligne : la fiche envoyée
   * devient la fiche du plat. C'est ce qui permet à l'écran de la traiter
   * comme un formulaire et non comme une suite d'appels.
   */
  async save(
    menuItemId: string,
    dto: SaveRecipeDto,
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const menuItem = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null },
      select: { id: true, name: true, price: true, promoPrice: true },
    });
    if (!menuItem) throw AppException.notFound('Plat introuvable.');
    const restaurantId = maisonExigee();

    // Deux fois le même article dans la fiche est une erreur de saisie :
    // le dire vaut mieux que d'en garder silencieusement un seul.
    const seen = new Set<string>();
    for (const line of dto.ingredients) {
      if (seen.has(line.stockItemId)) {
        throw AppException.badRequest(
          ERROR_CODES.VALIDATION_ERROR,
          'Un même article ne peut apparaître qu’une fois dans la fiche technique.',
          { stockItemId: line.stockItemId },
        );
      }
      seen.add(line.stockItemId);
    }

    if (dto.ingredients.length > 0) {
      // Seuls les articles du stock de cette maison sont admis.
      const known = await this.prisma.stockItem.count({
        where: { id: { in: [...seen] }, deletedAt: null, restaurantId },
      });
      if (known !== seen.size) {
        throw AppException.badRequest(
          ERROR_CODES.NOT_FOUND,
          'Un article de la fiche technique n’existe plus dans le stock.',
        );
      }
    }

    const lines = await this.prisma.transaction(async (tx) => {
      // On ne remplace que la fiche de cette maison : celle de l'autre,
      // faite de son propre stock, ne doit pas disparaître.
      await tx.recipeIngredient.deleteMany({ where: { menuItemId, stockItem: { restaurantId } } });

      if (dto.ingredients.length > 0) {
        await tx.recipeIngredient.createMany({
          data: dto.ingredients.map((line) => ({
            menuItemId,
            stockItemId: line.stockItemId,
            quantity: Math.round(line.quantity * 1000) / 1000,
            note: line.note ?? null,
          })),
        });
      }

      return tx.recipeIngredient.findMany({
        where: { menuItemId, stockItem: { restaurantId } },
        include: RECIPE_INCLUDE,
        orderBy: { stockItem: { name: 'asc' } },
      });
    });

    await this.audit.record({
      actor,
      action: 'RECIPE_UPDATE',
      module: 'menu',
      entityType: 'MenuItem',
      entityId: menuItemId,
      newValue: {
        menuItem: menuItem.name,
        ingredients: lines.length,
        cost: lines.reduce((total, line) => total + line.quantity * line.stockItem.averageCost, 0),
      },
      context,
    });

    return this.toDto(menuItem, lines);
  }

  // ───────────────────────── Sortie de la matière ─────────────────────────

  /**
   * Sort de la réserve ce que la commande a consommé.
   *
   * Appelée quand la préparation commence — c'est là que la matière quitte
   * réellement le frigo, pas à la prise de commande (qui peut être annulée)
   * ni à la livraison (le plat est déjà cuit).
   *
   * Trois choix assumés :
   *
   *  • **Idempotence par `stockConsumedAt`** : une commande ne se déduit
   *    qu'une fois, quels que soient les aller-retours de statut.
   *
   *  • **Le stock peut passer sous zéro.** Refuser la sortie parce que le
   *    compteur annonce zéro reviendrait à nier une vente qui a eu lieu. Un
   *    stock négatif est un signal fort — « on a vendu plus qu'on n'a
   *    déclaré acheter » — et il remonte tout seul dans les alertes.
   *
   *  • **Jamais bloquante.** Un échec de déduction est journalisé, il
   *    n'annule pas la commande : la cuisine ne s'arrête pas pour une
   *    écriture comptable.
   */
  async consumeForOrder(orderId: string, actorId: string | null): Promise<void> {
    try {
      await this.prisma.transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            reference: true,
            restaurantId: true,
            stockConsumedAt: true,
            items: { select: { menuItemId: true, quantity: true } },
          },
        });

        if (!order || order.stockConsumedAt) return;

        // La maison qui a préparé : c'est de sa réserve que sort la matière.
        const consumptions = await this.resolveConsumptions(tx, order.items, order.restaurantId);

        // On marque d'abord : si une écriture échoue ensuite, on préfère
        // une déduction incomplète à une double déduction au prochain
        // passage de statut.
        await tx.order.update({
          where: { id: order.id },
          data: { stockConsumedAt: new Date() },
        });

        for (const consumption of consumptions) {
          await this.stock.applyMovement(tx, {
            stockItemId: consumption.stockItemId,
            type: StockMovementType.OUT,
            reason: StockMovementReason.PREPARATION,
            quantity: consumption.quantity,
            note: `Préparation ${order.reference}`,
            // La clé, et pas seulement la référence dans le texte : c'est
            // par elle qu'on retrouve ce qu'un achat a rapporté.
            orderId: order.id,
            createdById: actorId,
            allowNegative: true,
          });
        }
      });
    } catch (error) {
      this.logger.error(
        `Sortie de stock impossible pour la commande ${orderId} : ${(error as Error).message}`,
      );
    }
  }

  /**
   * Additionne les fiches techniques des plats commandés.
   *
   * Un même ingrédient présent dans deux plats donne une seule sortie de
   * stock : le journal reste lisible, une ligne par article et par commande.
   */
  private async resolveConsumptions(
    tx: Prisma.TransactionClient,
    items: { menuItemId: string | null; quantity: number }[],
    restaurantId: string,
  ): Promise<Consumption[]> {
    const menuItemIds = [
      ...new Set(items.map((item) => item.menuItemId).filter((id): id is string => Boolean(id))),
    ];
    if (menuItemIds.length === 0) return [];

    const recipes = await tx.recipeIngredient.findMany({
      where: { menuItemId: { in: menuItemIds }, stockItem: { restaurantId } },
      include: { stockItem: { select: { id: true, name: true } } },
    });
    if (recipes.length === 0) return [];

    const byMenuItem = new Map<string, typeof recipes>();
    for (const line of recipes) {
      const lines = byMenuItem.get(line.menuItemId) ?? [];
      lines.push(line);
      byMenuItem.set(line.menuItemId, lines);
    }

    const totals = new Map<string, Consumption>();
    for (const item of items) {
      if (!item.menuItemId) continue;
      for (const line of byMenuItem.get(item.menuItemId) ?? []) {
        const current = totals.get(line.stockItemId);
        const quantity = line.quantity * item.quantity;

        if (current) current.quantity += quantity;
        else {
          totals.set(line.stockItemId, {
            stockItemId: line.stockItemId,
            name: line.stockItem.name,
            quantity,
          });
        }
      }
    }

    return [...totals.values()].map((consumption) => ({
      ...consumption,
      quantity: Math.round(consumption.quantity * 1000) / 1000,
    }));
  }

  // ──────────────────────────── Sérialisation ─────────────────────────────

  private toDto(
    menuItem: { id: string; name: string; price: number; promoPrice: number | null },
    lines: RecipeLine[],
  ) {
    const cost = Math.round(
      lines.reduce((total, line) => total + line.quantity * line.stockItem.averageCost, 0),
    );
    const sellingPrice = menuItem.promoPrice ?? menuItem.price;
    const margin = sellingPrice - cost;

    return {
      menuItemId: menuItem.id,
      menuItemName: menuItem.name,
      sellingPrice,
      /// Coût matière d'une portion, au coût moyen pondéré du jour.
      cost,
      margin,
      /// Marge rapportée au prix de vente, en pourcentage.
      marginRate: sellingPrice > 0 ? Math.round((margin / sellingPrice) * 1000) / 10 : 0,
      ingredients: lines.map((line) => ({
        id: line.id,
        stockItemId: line.stockItemId,
        name: line.stockItem.name,
        unit: toWire(line.stockItem.unit),
        quantity: line.quantity,
        unitCost: line.stockItem.averageCost,
        lineCost: Math.round(line.quantity * line.stockItem.averageCost),
        /// Stock restant de cet article : de quoi voir ce qui manque.
        available: line.stockItem.quantity,
        note: line.note,
      })),
    };
  }
}
