const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { IsSelfOrAdmin, School } = require('./school')
const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { toId, newId } = require('../lib/id-util')

route.post('/schools/:id/reservations/',
    IsSelfOrAdmin,
    LogOp('reservation', 'reserve'),
    School,
    async ctx => {
        if ( ctx.token.access.indexOf('admin') === -1
             && ( ctx.school.stage.endsWith('.paid')
               || ctx.school.stage.endsWith('.complete')
               || Number(ctx.school.stage[0]) >= 3
             )
        ) {
            ctx.status = 412
            ctx.body = { error: 'incorrect stage to make reservations' }
            return
        }

        let reservations = getPayload(ctx)

        if ( ! reservations.length ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        // verify checkIn/Out
        let valid = (
            await Promise.all(
                reservations.map( $ =>
                    ctx.db.collection('hotel').findOne({ _id: $.hotel })
                    .then( hotel =>
                        hotel
                        && $.checkIn
                        && $.checkOut
                        && new Date($.checkIn).getTime() >= new Date(hotel.notBefore).getTime()
                        && new Date($.checkOut).getTime() <= new Date(hotel.notAfter).getTime()
                    )
                )
            )
        ).every( v => v )

        if (!valid) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let restore = []
        let processed = 0
        for (; processed!==reservations.length; ++processed) {
            let $ = reservations[processed]
            let {
                modifiedCount
            } = await ctx.db.collection('hotel').updateOne(
                { _id: $.hotel, available: { $gt: 0 } },
                { $inc: { available: -1 } }
            )
            if (modifiedCount !== 1)
                break
            restore.push([ { _id: $.hotel }, { $inc: { available: 1} } ])
        }

        if (processed !== reservations.length) {
            // insufficient room
            await Promise.all( restore.map( $ => ctx.db.collection('hotel').update(...$) ) )
            ctx.status = 410
            ctx.body = { error: 'gone' }
        } else {
            // sufficient room, batch insert reservations
            let {
                insertedIds
            } = await ctx.db.collection('reservation').insertMany(
                reservations.map( $ => ({
                    _id: newId(),
                    hotel: $.hotel,
                    school: ctx.params.id,
                    checkIn: $.checkIn,
                    checkOut: $.checkOut,
                    round: ctx.school.stage[0],
                    created: new Date()
                }))
            )
            await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { stage: `${ctx.school.stage[0]}.payment` } }
            )
            ctx.status = 200
            ctx.body = { inserted: insertedIds }
        }
    }
)

route.get('/schools/:id/reservations/',
    IsSelfOrAdmin,
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('reservation').aggregate([
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
            { $unwind: '$hotel' },
            { $unwind: '$school' },
            { $project: {
                _id: false,
                id: '$_id',
                checkIn: '$checkIn',
                checkOut: '$checkOut',
                round: { $ifNull: ['$round', '1'] },
                hotel: {
                    id: '$hotel._id',
                    name: '$hotel.name',
                    type: '$hotel.type',
                    price: '$hotel.price',
                },
                school: {
                    id: '$school._id',
                    name: '$school.school.name'
                }
            } }
        ]).toArray()
    }
)

route.get('/schools/:id/reservations/:rid',
    IsSelfOrAdmin,
    async ctx => {
        let reservation = await ctx.db.collection('reservation').findOne({ _id: ctx.params.rid, school: ctx.params.id })
        if (reservation) {
            let hotel = await ctx.db.collection('hotel').findOne({ _id: reservation.hotel })
            let school = await ctx.db.collection('school').findOne({ _id: reservation.school })

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
                    price: hotel.price
                },
                school: {
                    id: school._id,
                    name: school.school.name
                }
            }
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.delete('/schools/:id/reservations/:rid',
    IsSelfOrAdmin,
    LogOp('reservation', 'delete'),
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

        ctx.status = 200
        ctx.body = { message: 'deleted' }
    }
)

module.exports = {
    routes: route.routes()
}
