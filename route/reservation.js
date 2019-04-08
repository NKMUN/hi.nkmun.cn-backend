const Router = require('koa-router')
const route = new Router()
const { IsSchoolSelfOr, School } = require('./school')
const getPayload = require('./lib/get-payload')
const { newId } = require('../lib/id-util')
const { writeSchoolOpLog } = require('./op-log')

const Route_GetReservationById = async ctx => {
    let reservation = await ctx.db.collection('reservation').findOne({ _id: ctx.params.rid, school: ctx.params.id })
    if (reservation) {
        let hotel = await ctx.db.collection('hotel').findOne({ _id: reservation.hotel })
        let school = await ctx.db.collection('school').findOne({ _id: reservation.school })
        let roomshareSchool = reservation.roomshare
            ? await ctx.db.collection('school').findOne({ _id: reservation.roomshare.school })
            : null

        ctx.status = 200
        ctx.body = {
            id: reservation._id,
            checkIn: reservation.checkIn,
            checkOut: reservation.checkOut,
            round: reservation.round || '1',
            hotel: {
                id: hotel._id,
                name: hotel.name,
                type: hotel.type,
                price: hotel.price,
                notBefore: hotel.notBefore,
                notAfter: hotel.notAfter
            },
            school: {
                id: school._id,
                name: school.school.name
            },
            roomshare: reservation.roomshare
                ? { school: { id: roomshareSchool._id, name: roomshareSchool.school.name },
                    state: reservation.roomshare.state }
                : null
        }
    } else {
        ctx.status = 404
        ctx.body = { error: 'not found' }
    }
}

route.get('/schools/:id/reservations/:rid',
    IsSchoolSelfOr('staff.accommodation'),
    Route_GetReservationById
)

route.post('/schools/:id/reservations/',
    IsSchoolSelfOr('staff.accommodation'),
    School,
    async ctx => {
        if ( ! ctx.hasAccessTo('staff.accommodation')
             && ( ctx.school.stage.endsWith('.paid')
               || ctx.school.stage.endsWith('.complete')
               || Number(ctx.school.stage[0]) >= 3
             )
        ) {
            ctx.status = 412
            ctx.body = { error: 'incorrect stage to make reservations' }
            return
        }

        let {
            hotel,
            checkIn,
            checkOut,
            roomshare,
        } = getPayload(ctx)

        let round = ['1', '2'].includes(ctx.school.stage[0]) ? ctx.school.stage[0] : '3'

        // verify checkIn/Out
        let valid = await ctx.db.collection('hotel')
                          .findOne({ _id: hotel })
                          .then(hotel =>
                              hotel
                              && checkIn
                              && checkOut
                              && new Date(checkIn).getTime() >= new Date(hotel.notBefore).getTime()
                              && new Date(checkOut).getTime() <= new Date(hotel.notAfter).getTime()
                          )

        if (!valid) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let {
            modifiedCount
        } = await ctx.db.collection('hotel').updateOne(
            { _id: hotel, available: { $gt: 0 } },
            { $inc: { available: -1 } }
        )

        if (modifiedCount !== 1) {
            ctx.status = 409
            ctx.body = { error: 'no stock' }
            return
        }

        const roomshareWillBeConfirmed = ctx.hasAccessTo('staff.accommodation')

        const {
            insertedId
        } = await ctx.db.collection('reservation').insertOne({
            _id: newId(),
            hotel: hotel,
            school: ctx.params.id,
            checkIn: checkIn,
            checkOut: checkOut,
            round,
            created: new Date(),
            roomshare: roomshare
                ? { school: roomshare,
                    state: roomshareWillBeConfirmed ? 'accepted' : 'pending' }
                : null
        })

        // generate op-log entry
        const hotelInfo = await ctx.db.collection('hotel').findOne({ _id: hotel })
        const roomshareRecipient = roomshare && roomshareWillBeConfirmed
            ? await ctx.db.collection('school').findOne({ _id: roomshare })
            : null
        const roomshareRecipientIdentifier = roomshareRecipient && (roomshareRecipient.identifier || roomshareRecipient.school.name)
        await writeSchoolOpLog(
            ctx,
            ctx.school._id,
            'reservation',
            `酒店预订(${ctx.school.stage[0]})：${hotelInfo.name} ${hotelInfo.type} (${insertedId})`,
            { hotel: {
                id: hotelInfo._id,
                name: hotelInfo.name,
                type: hotelInfo.type,
                checkIn,
                checkOut,
                roomshare: roomshareWillBeConfirmed
                    ? {
                        id: roomshare,
                        identifier: roomshareRecipientIdentifier
                    }
                    : null
            } }
        )

        if (roomshareRecipient) {
            const initiatingSchoolIdentifier = ctx.school.identifier || ctx.school.school.name
            await writeSchoolOpLog(
                ctx,
                ctx.school._id,
                'roomshare',
                `获得拼房(${ctx.school.stage[0]})：来自「${initiatingSchoolIdentifier}」${hotelInfo.name} ${hotelInfo.type} (${insertedId})`,
                { hotel: {
                    id: hotelInfo._id,
                    name: hotelInfo.name,
                    type: hotelInfo.type,
                    checkIn,
                    checkOut,
                    initiatingSchool: {
                        id: ctx.school._id,
                        identifier: initiatingSchoolIdentifier
                    }
                } }
            )
        }

        ctx.status = 200
        ctx.params.rid = insertedId
        await Route_GetReservationById(ctx)
    }
)

route.get('/schools/:id/reservations/',
    IsSchoolSelfOr('staff.accommodation'),
    async ctx => {
        const selfReservations = await ctx.db.collection('reservation').aggregate([
            { $match: { school: ctx.params.id } },
            { $lookup: {
                from: 'hotel',
                localField: 'hotel',
                foreignField: '_id',
                as: 'hotel'
            }},
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'school'
            } },
            { $lookup: {
                from: 'school',
                localField: 'roomshare.school',
                foreignField: '_id',
                as: 'roomshareSchool'
            } },
            { $unwind: '$hotel' },
            { $unwind: '$school' },
            { $project: {
                _id: false,
                id: '$_id',
                type: 'reservation',
                checkIn: '$checkIn',
                checkOut: '$checkOut',
                round: { $ifNull: ['$round', '1'] },
                hotel: {
                    id: '$hotel._id',
                    name: '$hotel.name',
                    type: '$hotel.type',
                    price: '$hotel.price',
                    notBefore: '$hotel.notBefore',
                    notAfter: '$hotel.notAfter'
                },
                school: {
                    id: '$school._id',
                    name: { $ifNull: ['$school.identifier', '$school.school.name'] },
                },
                roomshare: { $cond: {
                    if: { $eq: ['$roomshare', null] },
                    then: null,
                    else: {
                        school: '$roomshareSchool',
                        state: '$roomshare.state'
                    }
                }}
            } }
        ])
        .map($ => {
            // manual unwind roomshareSchool
            if ($.roomshare && $.roomshare.school.length)
                $.roomshare.school = {
                    id: $.roomshare.school[0]._id,
                    name: $.roomshare.school[0].identifier
                }
            return $
        })
        .toArray()

        const roomshares = await ctx.db.collection('reservation').aggregate([
            { $match: { 'roomshare.school': ctx.params.id, 'roomshare.state': { $ne: 'rejected' } } },
            { $lookup: {
                from: 'hotel',
                localField: 'hotel',
                foreignField: '_id',
                as: 'hotel'
            }},
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'roomshareSchool'
            } },
            { $lookup: {
                from: 'school',
                localField: 'roomshare.school',
                foreignField: '_id',
                as: 'school'
            } },
            { $unwind: '$hotel' },
            { $unwind: '$school' },
            { $unwind: '$roomshareSchool' },
            { $project: {
                _id: false,
                id: '$_id',
                type: 'roomshare',
                checkIn: '$checkIn',
                checkOut: '$checkOut',
                round: 'roomshare',
                hotel: {
                    id: '$hotel._id',
                    name: '$hotel.name',
                    type: '$hotel.type',
                    price: '$hotel.price',
                    notBefore: '$hotel.notBefore',
                    notAfter: '$hotel.notAfter'
                },
                school: {
                    id: '$school._id',
                    name: { $ifNull: ['$school.identifier', '$school.school.name'] },
                },
                roomshare: {
                    school: {
                        id: '$roomshareSchool._id',
                        name: { $ifNull: ['$roomshareSchool.identifier', '$roomshareSchool.school.name'] },
                    },
                    state: '$roomshare.state'
                }
            } }
        ]).toArray()

        ctx.status = 200
        ctx.body = [ ...selfReservations, ...roomshares ]
    }
)

route.patch('/schools/:id/reservations/:rid',
    IsSchoolSelfOr('staff.accommodation'),
    School,
    async ctx => {
        if ( ! ctx.hasAccessTo('staff.accommodation')
            && ( ctx.school.stage.endsWith('.paid')
            || ctx.school.stage.endsWith('.complete')
            || Number(ctx.school.stage[0]) >= 3
            )
        ) {
            ctx.status = 412
            ctx.body = { error: 'incorrect stage to make reservations' }
            return
        }

        let {
            checkIn,
            checkOut,
            roomshare
        } = getPayload(ctx)

        const reservation = await ctx.db.collection('reservation').findOne({ _id: ctx.params.rid })
        const hotelInfo = await ctx.db.collection('hotel').findOne({ _id: reservation.hotel })

        // verify checkIn / checkOut
        if (checkIn || checkOut) {
            const valid = (checkIn ? new Date(checkIn).getTime() >= new Date(hotelInfo.notBefore).getTime() : true)
                       && (checkOut ? new Date(checkOut).getTime() <= new Date(hotelInfo.notAfter).getTime() : true)
            if (!valid) {
                ctx.status = 400
                ctx.body = { error: 'bad request', message: 'checkIn or checkOut beyond hotel time limits' }
                return
            }
        }

        let update = {
            modified_at: new Date()
        }
        if (ctx.hasAccessTo('staff.accommodation')) {
            // staff can do anything they want
            if (checkIn) {
                update.checkIn = checkIn
            }
            if (checkOut) {
                update.checkOut = checkOut
            }
            if (roomshare === null) {
                update.roomshare = null
            } else {
                if (!reservation.roomshare || reservation.roomshare.school !== roomshare) {
                    update.roomshare = {
                        school: roomshare,
                        state: roomshare ? 'accepted' : null
                    }
                }
            }
        } else {
            // leader must stick with strict rules
            const school = await ctx.db.collection('school').findOne({ _id: ctx.params.id })
            const round = school.stage[0]
            if (reservation.round !== round) {
                ctx.status = 400
                ctx.body = { error: 'bad request', message: 'invalid stage to modify reservation' }
                return
            }
            if (roomshare !== undefined) {
                if (reservation.roomshare && reservation.roomshare.state === 'accepted') {
                    ctx.status = 400
                    ctx.body = { error: 'bad request', message: 'can not modify confirmed roomshare' }
                    return
                }
                if (roomshare === null) {
                    update.roomshare = null
                } else {
                    if (!reservation.roomshare || reservation.roomshare.school !== roomshare) {
                        update.roomshare = {
                            school: roomshare,
                            state: roomshare ? 'pending' : null
                        }
                    }
                }
            }
        }

        // update
        await ctx.db.collection('reservation').updateOne(
            { _id: ctx.params.rid },
            { $set: update }
        )

        // generate op-log entry
        const postUpdateReservation = await ctx.db.collection('reservation').findOne({ _id: ctx.params.rid })
        const roomshareRecipient = postUpdateReservation.roomshare && postUpdateReservation.roomshare.state === 'accepted'
            ? await ctx.db.collection('school').findOne({ _id: postUpdateReservation.roomshare.school })
            : null
        const roomshareRecipientIdentifier = roomshareRecipient && (roomshareRecipient.identifier || roomshareRecipient.school.name)
        await writeSchoolOpLog(
            ctx,
            ctx.school._id,
            'reservation',
            `修改酒店预订(${ctx.school.stage[0]})：${hotelInfo.name} ${hotelInfo.type} (${ctx.params.rid})`,
            { hotel: {
                id: hotelInfo._id,
                name: hotelInfo.name,
                type: hotelInfo.type,
                checkIn: postUpdateReservation.checkIn,
                checkOut: postUpdateReservation.checkOut,
                roomshare: roomshareRecipient
                    ? { id: roomshareRecipient._id, identifier: roomshareRecipientIdentifier }
                    : null
            } }
        )

        // only staff can change roomshare after peer confirmation
        const beforeUpdateRoomshareRecipientId = reservation.roomshare && reservation.roomshare.state === 'accepted' ? reservation.roomshare.school : null
        const postUpdateRoomshareRecipientId = roomshareRecipient ? roomshareRecipient._id : null
        const initiatingSchoolIdentifier = ctx.school.identifier || ctx.school.school.name

        if (beforeUpdateRoomshareRecipientId !== postUpdateRoomshareRecipientId) {
            if (beforeUpdateRoomshareRecipientId) {
                await writeSchoolOpLog(
                    ctx,
                    beforeUpdateRoomshareRecipientId,
                    'roomshare',
                    `拼房被撤销(${ctx.school.stage[0]})：${hotelInfo.name} ${hotelInfo.type} (${ctx.params.rid})`,
                    { hotel: {
                        id: hotelInfo._id,
                        name: hotelInfo.name,
                        type: hotelInfo.type,
                        checkIn: postUpdateReservation.checkIn,
                        checkOut: postUpdateReservation.checkOut,
                        initiatingSchool: {
                            id: ctx.school._id,
                            identifier: initiatingSchoolIdentifier
                        }
                    } }
                )
            }
            if (postUpdateRoomshareRecipientId) {
                await writeSchoolOpLog(
                    ctx,
                    postUpdateRoomshareRecipientId,
                    'roomshare',
                    `获得拼房(${ctx.school.stage[0]})：${hotelInfo.name} ${hotelInfo.type} (${ctx.params.rid})`,
                    { hotel: {
                        id: hotelInfo._id,
                        name: hotelInfo.name,
                        type: hotelInfo.type,
                        checkIn: postUpdateReservation.checkIn,
                        checkOut: postUpdateReservation.checkOut,
                        initiatingSchool: {
                            id: ctx.school._id,
                            identifier: initiatingSchoolIdentifier
                        }
                    } }
                )
            }
        } else {
            if (postUpdateRoomshareRecipientId) {
                await writeSchoolOpLog(
                    ctx,
                    postUpdateRoomshareRecipientId,
                    'roomshare',
                    `拼房信息被修改(${ctx.school.stage[0]})：${hotelInfo.name} ${hotelInfo.type} (${ctx.params.rid})`,
                    { hotel: {
                        id: hotelInfo._id,
                        name: hotelInfo.name,
                        type: hotelInfo.type,
                        checkIn: postUpdateReservation.checkIn,
                        checkOut: postUpdateReservation.checkOut,
                        initiatingSchool: {
                            id: ctx.school._id,
                            identifier: initiatingSchoolIdentifier
                        }
                    } }
                )
            }
        }

        // return result reservation
        await Route_GetReservationById(ctx)
    }
)

route.delete('/schools/:id/reservations/:rid',
    IsSchoolSelfOr('staff.accommodation'),
    School,
    async ctx => {
        let reservation = await ctx.db.collection('reservation').findOne({ _id: ctx.params.rid })

        if (!reservation) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
            return
        }

        await ctx.db.collection('reservation').deleteOne({ _id: ctx.params.rid })
        await ctx.db.collection('hotel').updateOne(
            { _id: reservation.hotel },
            { $inc: { available: 1 } }
        )

        const hotelInfo = await ctx.db.collection('hotel').findOne({ _id: reservation.hotel })
        const roomshareRecipient = reservation.roomshare && reservation.roomshare.state === 'accepted'
            ? await ctx.db.collection('school').findOne({ _id: reservation.roomshare.school })
            : null
        const roomshareRecipientIdentifier = roomshareRecipient && (roomshareRecipient.identifier || roomshareRecipient.school.name)
        await writeSchoolOpLog(
            ctx,
            ctx.school._id,
            'reservation',
            `取消酒店预订(${ctx.school.stage[0]})：${hotelInfo.name} ${hotelInfo.type} (${ctx.params.rid})`,
            { hotel: {
                id: hotelInfo._id,
                name: hotelInfo.name,
                type: hotelInfo.type,
                checkIn: reservation.checkIn,
                checkOut: reservation.checkOut,
                roomshare: roomshareRecipient
                    ? { id: roomshareRecipient._id, identifier: roomshareRecipientIdentifier }
                    : null
            } }
        )

        if (roomshareRecipient) {
            const initiatorId = ctx.school._id
            const initiatorIdentifier = ctx.school.identifier || ctx.school.school.name
            await writeSchoolOpLog(
                ctx,
                roomshareRecipient._id,
                'roomshare',
                `拼房被撤销：「${initiatorIdentifier}」 的 ${hotelInfo.name} ${hotelInfo.type}`,
                { hotel: {
                    id: hotelInfo._id,
                    name: hotelInfo.name,
                    type: hotelInfo.type,
                    checkIn: reservation.checkIn,
                    checkOut: reservation.checkOut,
                    initiatingSchool: {
                        id: initiatorId,
                        identifier: initiatorIdentifier
                    }
                } }
            )
        }

        ctx.status = 200
        ctx.body = { message: 'deleted' }
    }
)

route.post('/schools/:id/roomshare/:rid',
    IsSchoolSelfOr('staff.accommodation'),
    async ctx => {
        const {
            accept,
            reject
        } = getPayload(ctx)

        let update = {
            responded_at: new Date()
        }
        if (accept) {
            update = { 'roomshare.state': 'accepted' }
        }
        if (reject) {
            update = { 'roomshare.state': 'rejected' }
        }

        const {
            modifiedCount
        } = await ctx.db.collection('reservation').updateOne(
            { _id: ctx.params.rid, 'roomshare.school': ctx.params.id, 'roomshare.state': 'pending' },
            { $set: update }
        )

        if (modifiedCount === 1) {
            const reservation = await ctx.db.collection('reservation').findOne({ _id: ctx.params.rid })
            const hotel = await ctx.db.collection('hotel').findOne({ _id: reservation.hotel })
            // roomshare reservation is stored on initiating school
            const recipientSchool = await ctx.db.collection('school').findOne({ _id: ctx.params.id })
            const initiatingSchool = await ctx.db.collection('school').findOne({ _id: reservation.school })

            // generate op-log entry
            const initiatingSchoolIdentifier = initiatingSchool.identifier || initiatingSchool.school.name
            await writeSchoolOpLog(
                ctx,
                ctx.params.id,
                'roomshare',
                `接受拼房：来自「${initiatingSchoolIdentifier}」的「${hotel.name} ${hotel.type}」 (${ctx.params.rid})`,
                { hotel: {
                    id: hotel._id,
                    name: hotel.name,
                    type: hotel.type,
                    checkIn: reservation.checkIn,
                    checkOut: reservation.checkOut,
                    initiatingSchool: {
                        id: initiatingSchool._id,
                        identifier: initiatingSchoolIdentifier
                    }
                } }
            )

            const recipientSchoolIdentifier = recipientSchool.identifier || recipientSchool.school.name
            await writeSchoolOpLog(
                ctx,
                initiatingSchool._id,
                'roomshare',
                `拼房被接受：与「${recipientSchoolIdentifier}」拼房「${hotel.name} ${hotel.type}」 (${ctx.params.rid})`,
                { hotel: {
                    id: hotel._id,
                    name: hotel.name,
                    type: hotel.type,
                    checkIn: reservation.checkIn,
                    checkOut: reservation.checkOut,
                    roomshare: {
                        id: recipientSchool._id,
                        identifier: recipientSchoolIdentifier
                    }
                } }
            )


            // NOTE: match format returned by GET /reservations/
            ctx.status = 200
            ctx.body = {
                id: reservation._id,
                type: 'roomshare',
                checkIn: reservation.checkIn,
                checkOut: reservation.checkOut,
                round: 'roomshare',
                hotel: {
                    id: hotel._id,
                    name: hotel.name,
                    type: hotel.type,
                    price: hotel.price,
                    notBefore: hotel.notBefore,
                    notAfter: hotel.notAfter
                },
                school: {
                    id: recipientSchool._id,
                    name: recipientSchool.identifier || recipientSchool.school.name
                },
                roomshare: {
                    school: {
                        id: initiatingSchool._id,
                        name: initiatingSchool.identifier || initiatingSchool.school.name
                    },
                    state: reservation.roomshare.state
                }
            }
        } else {
            ctx.status = 409
            ctx.body = { error: 'peer cancelled', message: 'peer cancelled roomshare' }
        }
    }
)

module.exports = {
    routes: route.routes()
}
