import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuthOrToken } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import {
    TasteProfileUnavailableError,
    tasteProfileService,
} from "../services/tasteProfile";
import { sendRouteError } from "../utils/routeErrorResponse";

const router = Router();
const tasteLabelSchema = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

function distinctLabels(values: string[]): string[] {
    const seen = new Set<string>();
    return values.filter((value) => {
        const key = value.toLocaleLowerCase("en-US");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const tasteProfileRequestSchema = z
    .object({
        genres: z
            .array(tasteLabelSchema)
            .max(10)
            .default([])
            .transform(distinctLabels),
        artists: z
            .array(tasteLabelSchema)
            .max(10)
            .default([])
            .transform(distinctLabels),
        skip: z.boolean().default(false),
    })
    .strict()
    .superRefine((value, context) => {
        const signalCount = value.genres.length + value.artists.length;
        if (value.skip && signalCount > 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Skip cannot include taste selections",
            });
            return;
        }
        if (!value.skip && (signalCount < 3 || signalCount > 16)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Choose between 3 and 16 taste signals",
            });
        }
    });

router.use(requireAuthOrToken);

/**
 * @openapi
 * components:
 *   schemas:
 *     TasteSeedTrack:
 *       type: object
 *       additionalProperties: false
 *       required: [id, videoId, title, artist, album, duration, thumbnailUrl, artistId, albumId]
 *       properties:
 *         id:
 *           type: string
 *         videoId:
 *           type: string
 *         title:
 *           type: string
 *         artist:
 *           type: string
 *         album:
 *           type: string
 *         duration:
 *           type: integer
 *           minimum: 0
 *         thumbnailUrl:
 *           type: string
 *           format: uri
 *         artistId:
 *           type: string
 *           nullable: true
 *         albumId:
 *           type: string
 *           nullable: true
 *     TasteProfile:
 *       type: object
 *       additionalProperties: false
 *       required: [genres, artists, seedTracks]
 *       properties:
 *         genres:
 *           type: array
 *           maxItems: 10
 *           items:
 *             type: string
 *         artists:
 *           type: array
 *           maxItems: 10
 *           items:
 *             type: string
 *         seedTracks:
 *           type: array
 *           minItems: 1
 *           maxItems: 12
 *           items:
 *             $ref: '#/components/schemas/TasteSeedTrack'
 *     TasteProfileState:
 *       type: object
 *       additionalProperties: false
 *       required: [profile, completedAt, skippedAt, needsOnboarding]
 *       properties:
 *         profile:
 *           allOf:
 *             - $ref: '#/components/schemas/TasteProfile'
 *           nullable: true
 *         completedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         skippedAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         needsOnboarding:
 *           type: boolean
 *     TasteProfileWrite:
 *       type: object
 *       additionalProperties: false
 *       properties:
 *         genres:
 *           type: array
 *           maxItems: 10
 *           items:
 *             type: string
 *         artists:
 *           type: array
 *           maxItems: 10
 *           items:
 *             type: string
 *         skip:
 *           type: boolean
 *       description: Choose 3-16 distinct genres and artists, or send only skip=true
 */

/**
 * @openapi
 * /api/taste-profile:
 *   get:
 *     summary: Get the authenticated account's taste onboarding state
 *     tags: [Taste profile]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Account-scoped taste profile and onboarding decision
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TasteProfileState'
 *       401:
 *         description: Not authenticated
 */
async function handleGetProfile(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required", {
            code: "AUTH_REQUIRED",
        });
    }
    return res.json(await tasteProfileService.getProfile(userId));
}

/**
 * @openapi
 * /api/taste-profile:
 *   post:
 *     summary: Complete or skip taste onboarding for the authenticated account
 *     tags: [Taste profile]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TasteProfileWrite'
 *     responses:
 *       200:
 *         description: Updated account-scoped taste profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TasteProfileState'
 *       400:
 *         description: Invalid profile selection
 *       401:
 *         description: Not authenticated
 *       503:
 *         description: Provider could not resolve a playable seed
 *   put:
 *     summary: Replace or skip the authenticated account's taste profile
 *     tags: [Taste profile]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TasteProfileWrite'
 *     responses:
 *       200:
 *         description: Replaced account-scoped taste profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TasteProfileState'
 *       400:
 *         description: Invalid profile selection
 *       401:
 *         description: Not authenticated
 *       503:
 *         description: Provider could not resolve a playable seed
 */
async function handleWriteProfile(req: Request, res: Response) {
    const parsed = tasteProfileRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return sendRouteError(res, 400, "Invalid taste profile", {
            code: "INVALID_TASTE_PROFILE",
        });
    }
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required", {
            code: "AUTH_REQUIRED",
        });
    }
    try {
        const result = parsed.data.skip
            ? await tasteProfileService.skipProfile(userId)
            : await tasteProfileService.saveProfile(userId, {
                  genres: parsed.data.genres,
                  artists: parsed.data.artists,
              });
        return res.json(result);
    } catch (error) {
        if (error instanceof TasteProfileUnavailableError) {
            return sendRouteError(
                res,
                503,
                "Music provider could not resolve taste seeds",
                { code: "TASTE_PROVIDER_UNAVAILABLE" },
            );
        }
        throw error;
    }
}

router.get("/", asyncHandler(handleGetProfile));
router.post("/", asyncHandler(handleWriteProfile));
router.put("/", asyncHandler(handleWriteProfile));

export default router;
