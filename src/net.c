// Multiplayer glue. Doom runs single-player in every browser; other players
// are "ghosts": MT_PLAYER mobjs with no player_t, moved from the network.
//
// Authority: the shooter decides hits. When the local player damages a ghost
// the damage is queued for JS, which sends it to that player; damage arriving
// from the network is applied to the local player with net_damage().
// Anything a ghost does locally (cosmetic rockets, tracers) never hurts.

#include <string.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "d_event.h"
#include "info.h"
#include "m_random.h"
#include "p_local.h"
#include "p_mobj.h"
#include "tables.h"
#include "r_main.h"
#include "r_state.h"
#include <stdlib.h>

#include "net.h"

// Defined in p_mobj.c but not exported by any header.
void P_CheckMissileSpawn(mobj_t *th);

#define EXPORT(name) __attribute__((export_name(name)))

static mobj_t *ghosts[NET_MAX_GHOSTS];
static int ghost_dead[NET_MAX_GHOSTS];
static int pending_damage[NET_MAX_GHOSTS];

static int net_applying;      // set while applying network damage
static int fire_count;        // bumps on every local trigger pull
static int death_count;       // local deaths
static int last_killer = -1;  // ghost slot of the last killer, -1 for none
static int net_frags;
static int was_dead;
static int dead_tics;

int Net_IsGhost(mobj_t *mo)
{
    if (!mo)
        return 0;
    for (int i = 0; i < NET_MAX_GHOSTS; i++)
        if (ghosts[i] == mo)
            return 1;
    return 0;
}

static int ghost_slot(mobj_t *mo)
{
    for (int i = 0; i < NET_MAX_GHOSTS; i++)
        if (ghosts[i] && ghosts[i] == mo)
            return i;
    return -1;
}

// Called from the top of P_DamageMobj. Returns 1 when the damage is handled
// here and must not be applied by the engine.
int Net_FilterDamage(mobj_t *target, mobj_t *source, int damage)
{
    int slot = ghost_slot(target);
    if (slot >= 0) {
        mobj_t *me = players[consoleplayer].mo;
        if (source && source == me && !ghost_dead[slot])
            pending_damage[slot] += damage;
        return 1;
    }
    if (source && !net_applying && Net_IsGhost(source))
        return 1;
    return 0;
}

void Net_LevelLoaded(void)
{
    // The level reset freed every mobj; forget the old pointers.
    memset(ghosts, 0, sizeof(ghosts));
    memset(ghost_dead, 0, sizeof(ghost_dead));
    memset(pending_damage, 0, sizeof(pending_damage));
    was_dead = 0;
}

void Net_LocalFired(player_t *player)
{
    if (player == &players[consoleplayer])
        fire_count++;
}

// ---- exports for JS ------------------------------------------------------

// Local player snapshot, 16 int32s:
//  0 x  1 y  2 z  3 angle  4 health  5 armor  6 weapon  7 dead  8 moving
//  9 fire_count  10 in_level  11 map  12 death_count  13 last_killer
EXPORT("net_local")
void net_local(int *out)
{
    player_t *p = &players[consoleplayer];
    mobj_t *mo = p->mo;
    memset(out, 0, 16 * sizeof(int));
    out[10] = (gamestate == GS_LEVEL && mo != NULL);
    out[11] = gamemap;
    out[9] = fire_count;
    out[12] = death_count;
    out[13] = last_killer;
    if (!out[10])
        return;
    out[0] = mo->x;
    out[1] = mo->y;
    out[2] = mo->z;
    out[3] = (int)mo->angle;
    out[4] = p->health;
    out[5] = p->armorpoints;
    out[6] = p->readyweapon;
    out[7] = p->playerstate == PST_DEAD;
    out[8] = (mo->momx | mo->momy) != 0;
}

// Called by JS after every tick: tracks deaths and keeps the HUD frag count.
EXPORT("net_after_tick")
void net_after_tick(void)
{
    player_t *p = &players[consoleplayer];
    int dead = gamestate == GS_LEVEL && p->playerstate == PST_DEAD;
    if (dead && !was_dead) {
        death_count++;
        last_killer = ghost_slot(p->attacker);
        dead_tics = 0;
        p->message = "CLICK OR PRESS SPACE TO RESPAWN";
    }
    was_dead = dead;

    // Doom only respawns on "use". Also take a click (after a short beat, so
    // a held trigger doesn't skip the death) and respawn on our own after 3 s.
    if (dead) {
        dead_tics++;
        if ((dead_tics > TICRATE / 2 && (p->cmd.buttons & BT_ATTACK)) || dead_tics > 3 * TICRATE)
            p->playerstate = PST_REBORN;
    }

    // The status bar sums frags[i] for every i != consoleplayer.
    memset(p->frags, 0, sizeof(p->frags));
    p->frags[consoleplayer == 0 ? 1 : 0] = net_frags;
}

extern int net_rng_seed;

// Call before dg_create so the first level already uses it.
EXPORT("net_seed")
void net_seed(int seed) { net_rng_seed = seed; }

EXPORT("net_set_frags")
void net_set_frags(int n) { net_frags = n; }

static void ghost_place(mobj_t *mo, fixed_t x, fixed_t y, fixed_t z, angle_t angle)
{
    P_UnsetThingPosition(mo);
    mo->x = x;
    mo->y = y;
    P_SetThingPosition(mo);
    mo->floorz = mo->subsector->sector->floorheight;
    mo->ceilingz = mo->subsector->sector->ceilingheight;
    mo->z = z < mo->floorz ? mo->floorz : z;
    mo->momx = mo->momy = mo->momz = 0;
    mo->angle = angle;
}

EXPORT("net_ghost_update")
void net_ghost_update(int slot, int x, int y, int z, int angle, int dead, int moving, int color)
{
    if (slot < 0 || slot >= NET_MAX_GHOSTS || gamestate != GS_LEVEL)
        return;
    mobj_t *mo = ghosts[slot];
    if (!mo) {
        mo = P_SpawnMobj(x, y, z, MT_PLAYER);
        mo->flags &= ~(MF_PICKUP | MF_TRANSLATION);
        mo->flags |= MF_NOGRAVITY | ((color & 3) << MF_TRANSSHIFT);
        mo->health = 100;
        ghosts[slot] = mo;
        ghost_dead[slot] = 0;
    }
    ghost_place(mo, x, y, z, (angle_t)angle);

    if (dead && !ghost_dead[slot]) {
        mo->flags &= ~MF_SHOOTABLE;
        P_SetMobjState(mo, S_PLAY_DIE1);
    } else if (!dead && ghost_dead[slot]) {
        mo->flags |= MF_SHOOTABLE | MF_SOLID;
        mo->health = 100;
        P_SetMobjState(mo, S_PLAY);
    } else if (!dead) {
        statenum_t st = mo->state - states;
        int running = st >= S_PLAY_RUN1 && st <= S_PLAY_RUN4;
        if (moving && st == S_PLAY)
            P_SetMobjState(mo, S_PLAY_RUN1);
        else if (!moving && running)
            P_SetMobjState(mo, S_PLAY);
    }
    ghost_dead[slot] = dead;
}

EXPORT("net_ghost_remove")
void net_ghost_remove(int slot)
{
    if (slot < 0 || slot >= NET_MAX_GHOSTS || !ghosts[slot])
        return;
    if (gamestate == GS_LEVEL)
        P_RemoveMobj(ghosts[slot]);
    ghosts[slot] = NULL;
    pending_damage[slot] = 0;
}

static void ghost_tracers(mobj_t *mo, int count, int spread)
{
    fixed_t slope = P_AimLineAttack(mo, mo->angle, 16 * 64 * FRACUNIT);
    for (int i = 0; i < count; i++) {
        angle_t an = mo->angle;
        fixed_t sl = slope;
        if (spread) {
            an += (P_Random() - P_Random()) << spread;
            if (spread > 18)
                sl += (P_Random() - P_Random()) << 5;
        }
        P_LineAttack(mo, an, MISSILERANGE, sl, 0); // 0 damage: puffs and blood only
    }
}

static void ghost_missile(mobj_t *mo, mobjtype_t type)
{
    angle_t an = mo->angle;
    fixed_t slope = P_AimLineAttack(mo, an, 16 * 64 * FRACUNIT);
    mobj_t *th = P_SpawnMobj(mo->x, mo->y, mo->z + 4 * 8 * FRACUNIT, type);
    th->target = mo;
    th->angle = an;
    an >>= ANGLETOFINESHIFT;
    th->momx = FixedMul(th->info->speed, finecosine[an]);
    th->momy = FixedMul(th->info->speed, finesine[an]);
    th->momz = FixedMul(th->info->speed, slope);
    P_CheckMissileSpawn(th);
}

// A remote player pulled the trigger: show it. Damage arrives separately.
EXPORT("net_ghost_fire")
void net_ghost_fire(int slot, int weapon)
{
    if (slot < 0 || slot >= NET_MAX_GHOSTS || !ghosts[slot] || ghost_dead[slot])
        return;
    mobj_t *mo = ghosts[slot];
    P_SetMobjState(mo, S_PLAY_ATK1);
    switch (weapon) {
    case wp_pistol:       ghost_tracers(mo, 1, 0); break;
    case wp_chaingun:     ghost_tracers(mo, 2, 18); break;
    case wp_shotgun:      ghost_tracers(mo, 7, 18); break;
    case wp_supershotgun: ghost_tracers(mo, 20, 19); break;
    case wp_missile:      ghost_missile(mo, MT_ROCKET); break;
    case wp_plasma:       ghost_missile(mo, MT_PLASMA); break;
    case wp_bfg:          ghost_missile(mo, MT_BFG); break;
    default: break; // fist and chainsaw: the attack frame is enough
    }
}

// Where to draw a ghost's name tag, using the renderer's own projection
// (same math as R_ProjectSprite). Writes 4 int32s: screen x, screen y of the
// point just above the head (320x200 pixels), visible flag, distance in map
// units. Hidden when behind the camera, off screen, or behind a wall.
EXPORT("net_ghost_screen")
void net_ghost_screen(int slot, int *out)
{
    out[0] = out[1] = out[2] = out[3] = 0;
    if (slot < 0 || slot >= NET_MAX_GHOSTS || !ghosts[slot] || gamestate != GS_LEVEL)
        return;
    mobj_t *mo = ghosts[slot];
    mobj_t *me = players[consoleplayer].mo;
    if (!me || ghost_dead[slot])
        return;

    fixed_t tr_x = mo->x - viewx;
    fixed_t tr_y = mo->y - viewy;
    fixed_t tz = FixedMul(tr_x, viewcos) + FixedMul(tr_y, viewsin);
    if (tz < 4 * FRACUNIT)
        return;
    fixed_t tx = FixedMul(tr_x, viewsin) - FixedMul(tr_y, viewcos);
    if (abs(tx) > (tz << 2))
        return;
    fixed_t scale = FixedDiv(projection, tz);
    fixed_t top = mo->z + mo->info->height + 6 * FRACUNIT;

    int x = ((centerxfrac + FixedMul(tx, scale)) >> FRACBITS) << detailshift;
    int y = (centeryfrac - FixedMul(top - viewz, scale)) >> FRACBITS;
    if (x < 0 || x >= (viewwidth << detailshift))
        return;
    if (!P_CheckSight(me, mo))
        return;

    out[0] = x + viewwindowx;
    out[1] = y + viewwindowy;
    out[2] = 1;
    out[3] = tz >> FRACBITS;
}

// Damage the local player dealt to each ghost since the last call.
EXPORT("net_take_hits")
void net_take_hits(int *out)
{
    memcpy(out, pending_damage, sizeof(pending_damage));
    memset(pending_damage, 0, sizeof(pending_damage));
}

// Damage dealt to the local player by the player behind ghost `slot`.
EXPORT("net_damage")
void net_damage(int slot, int damage)
{
    player_t *p = &players[consoleplayer];
    if (gamestate != GS_LEVEL || !p->mo || p->playerstate != PST_LIVE || damage <= 0)
        return;
    mobj_t *src = (slot >= 0 && slot < NET_MAX_GHOSTS) ? ghosts[slot] : NULL;
    net_applying = 1;
    P_DamageMobj(p->mo, src, src, damage);
    net_applying = 0;
}
