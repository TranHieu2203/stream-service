const map_peers = new Map();

const addPeer = (peer)=>{ 
    map_peers.set(peer.sessionId, peer);
}
const addSubcriber = (sessionId, subcriberSessionId)=>{ 
    let peer = map_peers.get(sessionId)
    peer.subcribers.push(subcriberSessionId)
    map_peers.set(sessionId, peer);
}
const updatePeer = (peer)=>{ 
    map_peers.set(peer.sessionId, peer);
}
const getPeer = (sessionId)=>{ 
    return map_peers.get(sessionId);
}
const removePeer = (sessionId)=>{ 
    return map_peers.delete(sessionId);
}


module.exports = {
    addPeer,
    updatePeer,
    addSubcriber,
    getPeer,
    removePeer
}