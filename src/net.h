#ifndef DOOM_ROOM_NET_H
#define DOOM_ROOM_NET_H

#include "d_player.h"
#include "p_mobj.h"

#define NET_MAX_GHOSTS 16

int Net_IsGhost(mobj_t *mo);
int Net_FilterDamage(mobj_t *target, mobj_t *source, int damage);
void Net_LevelLoaded(void);
void Net_LocalFired(player_t *player);

#endif
