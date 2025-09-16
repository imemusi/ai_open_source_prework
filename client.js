// MMORPG Client - Networking, Camera, and Rendering for "Pat"
(function () {
  const SERVER_URL = 'wss://codepath-mmorg.onrender.com';

  const canvas = document.getElementById('world-canvas');
  const ctx = canvas.getContext('2d');

  // World map
  const worldImage = new Image();
  worldImage.src = './world.jpg';

  // Connection state
  let socket = null;
  let isConnected = false;
  let joinComplete = false;

  // Game state (subset for milestone)
  let myPlayerId = null;
  let myPlayer = null; // { id, x, y, facing, isMoving, username, animationFrame, avatar }
  let myAvatarFrames = null; // { north: [Image, ...], south: [...], east: [...] }
  let allPlayers = {}; // { playerId: { id, x, y, facing, isMoving, username, animationFrame, avatar } }
  let allAvatars = {}; // { avatarName: { frames: { north: [...], south: [...], east: [...] } } }

  // Offscreen cache for currently selected frame (no scaling by default)
  let currentFrameImage = null;
  let currentFrameOffscreen = null; // Canvas

  // Render invalidation
  let needsRender = true;
  let worldLoaded = false;

  // Movement state
  let keysPressed = new Set();
  let lastMoveTime = 0;
  const MOVE_THROTTLE = 50; // ms between move commands

  // Flag state
  let flags = []; // Array of { x, y, playerId, username }
  let hasFlag = false; // Whether Pat is carrying a flag

  function sizeCanvasToWindow() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    needsRender = true;
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function computeCamera() {
    if (!myPlayer || !worldLoaded) {
      return { camX: 0, camY: 0 };
    }
    const cw = canvas.width;
    const ch = canvas.height;
    const ww = worldImage.naturalWidth;
    const wh = worldImage.naturalHeight;

    let targetX = myPlayer.x - Math.floor(cw / 2);
    let targetY = myPlayer.y - Math.floor(ch / 2);

    const maxCamX = Math.max(0, ww - cw);
    const maxCamY = Math.max(0, wh - ch);

    const camX = clamp(targetX, 0, maxCamX);
    const camY = clamp(targetY, 0, maxCamY);
    return { camX, camY };
  }

  function drawWorld(camX, camY) {
    const cw = canvas.width;
    const ch = canvas.height;
    const ww = worldImage.naturalWidth;
    const wh = worldImage.naturalHeight;

    // Source rectangle within the world image (no scaling)
    const sx = camX;
    const sy = camY;
    const sw = Math.min(cw, ww - sx);
    const sh = Math.min(ch, wh - sy);

    // Clear canvas
    ctx.clearRect(0, 0, cw, ch);

    // Draw visible region 1:1
    if (sw > 0 && sh > 0) {
      ctx.drawImage(worldImage, sx, sy, sw, sh, 0, 0, sw, sh);
    }
  }

  function ensureOffscreenForCurrentFrame() {
    if (!currentFrameImage) return;
    if (
      currentFrameOffscreen &&
      currentFrameOffscreen.width === currentFrameImage.naturalWidth &&
      currentFrameOffscreen.height === currentFrameImage.naturalHeight
    ) {
      return; // already matching
    }
    const off = document.createElement('canvas');
    off.width = currentFrameImage.naturalWidth;
    off.height = currentFrameImage.naturalHeight;
    const offCtx = off.getContext('2d');
    offCtx.drawImage(currentFrameImage, 0, 0);
    currentFrameOffscreen = off;
  }

  function pickCurrentFrame() {
    if (!myPlayer || !myAvatarFrames) return;
    const dir = myPlayer.facing || 'south';
    const index = myPlayer.animationFrame || 0;
    const dirFrames = myAvatarFrames[dir];
    if (!dirFrames || dirFrames.length === 0) return;
    const idx = Math.min(index, dirFrames.length - 1);
    currentFrameImage = dirFrames[idx];
    ensureOffscreenForCurrentFrame();
  }

  function getAvatarFrame(player) {
    if (!player || !player.avatar) return null;
    const avatarDef = allAvatars[player.avatar];
    if (!avatarDef || !avatarDef.frames) return null;
    
    const direction = player.facing || 'south';
    const frameIndex = player.animationFrame || 0;
    const frames = avatarDef.frames[direction];
    if (!frames || frames.length === 0) return null;
    
    const index = Math.min(frameIndex, frames.length - 1);
    return frames[index];
  }

  function drawPlayer(player, camX, camY, isMyPlayer = false) {
    if (!player) return;
    
    const frameImage = getAvatarFrame(player);
    
    // Convert world to screen and center sprite around player position
    const screenX = Math.floor(player.x - camX);
    const screenY = Math.floor(player.y - camY);

    if (frameImage) {
      const imgW = frameImage.naturalWidth;
      const imgH = frameImage.naturalHeight;
      const drawX = Math.floor(screenX - imgW / 2);
      const drawY = Math.floor(screenY - imgH / 2);
      
      // Draw avatar frame
      ctx.drawImage(frameImage, drawX, drawY);
    } else {
      // Fallback: draw a colored rectangle if no avatar
      const size = 32;
      const drawX = Math.floor(screenX - size / 2);
      const drawY = Math.floor(screenY - size / 2);
      
      ctx.fillStyle = isMyPlayer ? '#00ff00' : '#ff0000'; // Green for me, red for others
      ctx.fillRect(drawX, drawY, size, size);
    }

    // Draw flag if player is carrying one
    if (isMyPlayer && hasFlag) {
      drawFlag(screenX - 20, screenY - 30, '#ff0000'); // Red flag for Pat
    }

    // Username label above the avatar
    const label = player.username || 'Player';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const textX = Math.floor(screenX);
    const textY = Math.floor(screenY - 20);
    
    // Outline for readability
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(label, textX, textY);
    
    // Different colors for my player vs others
    ctx.fillStyle = isMyPlayer ? '#ffff00' : '#fff'; // Yellow for me, white for others
    ctx.fillText(label, textX, textY);
  }

  function drawFlag(x, y, color = '#ff0000') {
    // Draw flag pole
    ctx.fillStyle = '#8B4513'; // Brown
    ctx.fillRect(x, y, 2, 20);
    
    // Draw flag
    ctx.fillStyle = color;
    ctx.fillRect(x + 2, y, 12, 8);
    
    // Draw flag border
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 2, y, 12, 8);
  }

  function drawMyAvatar(camX, camY) {
    if (!myPlayer) return;
    drawPlayer(myPlayer, camX, camY, true);
  }

  function handleMovement() {
    if (!isConnected || !socket || keysPressed.size === 0) return;
    
    const now = Date.now();
    if (now - lastMoveTime < MOVE_THROTTLE) return;
    
    // Determine primary direction from pressed keys
    let direction = null;
    if (keysPressed.has('ArrowUp')) direction = 'up';
    if (keysPressed.has('ArrowDown')) direction = 'down';
    if (keysPressed.has('ArrowLeft')) direction = 'left';
    if (keysPressed.has('ArrowRight')) direction = 'right';
    
    if (direction) {
      socket.send(JSON.stringify({ action: 'move', direction }));
      lastMoveTime = now;
    }
  }

  function render() {
    // Handle movement every frame
    handleMovement();
    
    // Always render if we have players, regardless of needsRender flag
    if (!worldLoaded) {
      requestAnimationFrame(render);
      return;
    }
    
    const { camX, camY } = computeCamera();
    drawWorld(camX, camY);
    
    // Draw planted flags
    flags.forEach(flag => {
      const screenX = Math.floor(flag.x - camX);
      const screenY = Math.floor(flag.y - camY);
      if (screenX >= -20 && screenX <= canvas.width + 20 && 
          screenY >= -20 && screenY <= canvas.height + 20) {
        drawFlag(screenX, screenY, '#ff0000');
        // Draw flag owner label
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 2;
        ctx.strokeText(flag.username, screenX + 7, screenY + 25);
        ctx.fillText(flag.username, screenX + 7, screenY + 25);
      }
    });
    
    // Draw all players
    const playerCount = Object.keys(allPlayers).length;
    if (playerCount > 0) {
      Object.values(allPlayers).forEach(player => {
        drawPlayer(player, camX, camY, player.id === myPlayerId);
      });
    }
    
    needsRender = false;
    requestAnimationFrame(render);
  }

  function loadAvatarFrames(avatarDef) {
    // avatarDef.frames: { north: [dataURL...], south: [...], east: [...] }
    const directions = ['north', 'south', 'east'];
    const frames = {};
    let remaining = 0;
    let hadAny = false;

    directions.forEach((dir) => {
      const dirImgs = avatarDef.frames && avatarDef.frames[dir];
      if (!dirImgs || dirImgs.length === 0) return;
      frames[dir] = dirImgs.map((src) => {
        const img = new Image();
        img.src = src;
        remaining++;
        hadAny = true;
        img.onload = () => {
          remaining--;
          if (remaining === 0) {
            myAvatarFrames = frames;
            pickCurrentFrame();
            needsRender = true;
          }
        };
        img.onerror = () => {
          remaining--;
        };
        return img;
      });
    });

    if (!hadAny) {
      // No frames provided; fallback to placeholder
      myAvatarFrames = null;
      currentFrameImage = null;
      currentFrameOffscreen = null;
    }
  }

  function loadAllAvatarFrames(avatarDefs) {
    // Load frames for all avatars into allAvatars
    Object.keys(avatarDefs).forEach(avatarName => {
      const avatarDef = avatarDefs[avatarName];
      if (!avatarDef || !avatarDef.frames) return;
      
      const directions = ['north', 'south', 'east'];
      const frames = {};
      let remaining = 0;
      let hadAny = false;

      directions.forEach((dir) => {
        const dirImgs = avatarDef.frames && avatarDef.frames[dir];
        if (!dirImgs || dirImgs.length === 0) return;
        frames[dir] = dirImgs.map((src) => {
          const img = new Image();
          img.src = src;
          remaining++;
          hadAny = true;
          img.onload = () => {
            remaining--;
            if (remaining === 0) {
              allAvatars[avatarName] = { ...avatarDef, frames };
              needsRender = true;
            }
          };
          img.onerror = () => {
            remaining--;
            // If all images failed to load, still set the avatar with empty frames
            if (remaining === 0) {
              allAvatars[avatarName] = { ...avatarDef, frames: {} };
              needsRender = true;
            }
          };
          return img;
        });
      });

      if (!hadAny) {
        allAvatars[avatarName] = { ...avatarDef, frames: {} };
      }
    });
  }

  function connect() {
    socket = new WebSocket(SERVER_URL);
    socket.addEventListener('open', () => {
      isConnected = true;
      // Join with username "Pat"
      socket.send(
        JSON.stringify({ action: 'join_game', username: 'Pat' })
      );
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        const action = data && data.action;
        if (action === 'join_game' && data.success) {
          myPlayerId = data.playerId;
          const players = data.players || {};
          allPlayers = { ...players }; // Store all players
          myPlayer = players[myPlayerId];
          if (myPlayer) {
            // For milestone, ensure username is Pat
            myPlayer.username = myPlayer.username || 'Pat';
          }
          const avatars = data.avatars || {};
          loadAllAvatarFrames(avatars); // Load all avatar frames
          const myAvatarKey = myPlayer && myPlayer.avatar;
          const avatarDef = (myAvatarKey && avatars[myAvatarKey]) || null;
          if (avatarDef) {
            loadAvatarFrames(avatarDef);
          }
          joinComplete = true;
          needsRender = true;
          
          // Add a test flag for debugging
          flags.push({
            x: myPlayer.x + 100,
            y: myPlayer.y + 100,
            playerId: myPlayerId,
            username: 'Pat'
          });
        } else if (action === 'players_moved') {
          // Update all player positions when server broadcasts movement
          const players = data.players || {};
          Object.keys(players).forEach(playerId => {
            if (allPlayers[playerId]) {
              allPlayers[playerId] = { ...allPlayers[playerId], ...players[playerId] };
            }
          });
          // Update myPlayer reference to point to the updated data
          if (myPlayerId && allPlayers[myPlayerId]) {
            myPlayer = allPlayers[myPlayerId];
          }
          needsRender = true;
        } else if (action === 'player_joined') {
          // Add new player when someone joins
          const player = data.player;
          const avatar = data.avatar;
          if (player) {
            allPlayers[player.id] = player;
            if (avatar) {
              allAvatars[avatar.name] = avatar;
            }
            needsRender = true;
          }
        } else if (action === 'player_left') {
          // Remove player when they leave
          const playerId = data.playerId;
          if (playerId && allPlayers[playerId]) {
            delete allPlayers[playerId];
            needsRender = true;
          }
        } else if (action === 'flag_planted') {
          // Add new flag when someone plants one
          const flag = data.flag;
          if (flag) {
            flags.push(flag);
            needsRender = true;
          }
        } else if (action === 'flags_update') {
          // Update all flags (sent on join or when flags change)
          const flagsList = data.flags || [];
          flags = [...flagsList];
          needsRender = true;
        } else if (action === 'flag_picked_up') {
          // Player picked up a flag
          const playerId = data.playerId;
          if (playerId === myPlayerId) {
            hasFlag = true;
          }
          needsRender = true;
        } else if (action === 'flag_dropped') {
          // Player dropped a flag
          const playerId = data.playerId;
          if (playerId === myPlayerId) {
            hasFlag = false;
          }
          needsRender = true;
        }
      } catch (e) {
        // ignore malformed messages for now
      }
    });

    socket.addEventListener('close', () => {
      isConnected = false;
    });
    socket.addEventListener('error', () => {
      // No-op for milestone
    });
  }

  // Keyboard event handlers
  function handleKeyDown(event) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      event.preventDefault();
      keysPressed.add(event.code);
    } else if (event.code === 'KeyF') {
      event.preventDefault();
      console.log('F key pressed!');
      plantFlag();
    }
  }

  function handleKeyUp(event) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      event.preventDefault();
      keysPressed.delete(event.code);
      // Send stop command when releasing all keys
      if (keysPressed.size === 0 && isConnected && socket) {
        socket.send(JSON.stringify({ action: 'stop' }));
      }
    }
  }

  function plantFlag() {
    if (!isConnected || !socket || !myPlayer) {
      console.log('Cannot plant flag: not connected or no player');
      return;
    }
    
    console.log('Planting flag at:', myPlayer.x, myPlayer.y);
    
    // For now, let's just add a flag locally for testing
    const newFlag = {
      x: myPlayer.x,
      y: myPlayer.y,
      playerId: myPlayerId,
      username: 'Pat'
    };
    flags.push(newFlag);
    needsRender = true;
    
    // Send plant flag command to server (if server supports it)
    socket.send(JSON.stringify({ 
      action: 'plant_flag', 
      x: myPlayer.x, 
      y: myPlayer.y 
    }));
  }

  // Init
  worldImage.onload = function () {
    worldLoaded = true;
    sizeCanvasToWindow();
    needsRender = true;
  };

  if (worldImage.complete && worldImage.naturalWidth > 0) {
    worldLoaded = true;
  }

  window.addEventListener('resize', () => {
    sizeCanvasToWindow();
  });

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  sizeCanvasToWindow();
  connect();
  requestAnimationFrame(render);
})();


